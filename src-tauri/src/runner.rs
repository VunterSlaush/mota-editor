//! Process runner — spawns a provider's CLI for one turn and streams its
//! stdout through the provider's parser, emitting domain events to the
//! frontend. The only file that touches child processes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use agent_core::{AgentEvent, Provider, TurnCommand};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};

/// Upper bound on retained child output (stdout kept for `parse_final`,
/// stderr kept for error summaries). A misbehaving CLI can stream
/// without limit; the app must not buffer it all.
const MAX_CAPTURE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WireEvent<'a> {
    tab_id: &'a str,
    /// The tab's CONVERSATION this event belongs to. The tab id names the
    /// tab for its whole life, so on its own it cannot tell an event from
    /// the chat on screen apart from one a retired agent is still
    /// emitting under the same tab id (ADR-0016). Absent when no session
    /// stands behind the event.
    #[serde(skip_serializing_if = "Option::is_none")]
    chat_id: Option<&'a str>,
    event: &'a AgentEvent,
}

pub const EVENT_CHANNEL: &str = "agent-event";

/// Emit an event no session is responsible for — a transport failure, or
/// a line this app wrote itself. It belongs to whatever chat is current.
pub fn emit(app: &AppHandle, tab_id: &str, event: &AgentEvent) {
    let _ = app.emit(EVENT_CHANNEL, WireEvent { tab_id, chat_id: None, event });
}

/// Emit an event on behalf of the session serving `chat_id`.
pub fn emit_for(app: &AppHandle, tab_id: &str, chat_id: &str, event: &AgentEvent) {
    let _ = app.emit(EVENT_CHANNEL, WireEvent { tab_id, chat_id: Some(chat_id), event });
}

/// Spawn the turn's process. Returns the child so the caller can register
/// it for cancellation.
pub fn spawn(command: &TurnCommand, project_path: &Path) -> std::io::Result<Child> {
    let mut cmd = os_command(&command.program, &command.args);
    cmd.current_dir(project_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd.spawn()
}

/// Resolve a program name to an absolute path by scanning PATH (and
/// PATHEXT on Windows) — never the process or project working
/// directory, so a hostile project folder cannot shadow a tool with a
/// planted `npx.cmd`. Real executables (`.com`/`.exe`) are preferred
/// over batch shims across all PATH entries. Results are cached for the
/// process lifetime.
pub fn resolve_program(program: &str) -> Option<PathBuf> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<PathBuf>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = cache.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(found) = cache.get(program) {
        return found.clone();
    }
    let found = find_on_path(program);
    cache.insert(program.to_owned(), found.clone());
    found
}

fn find_on_path(program: &str) -> Option<PathBuf> {
    let as_path = Path::new(program);
    if as_path.is_absolute() {
        return as_path.is_file().then(|| as_path.to_owned());
    }
    let dirs: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH")?)
        .filter(|d| !d.as_os_str().is_empty())
        .collect();
    for name in candidate_names(program) {
        for dir in &dirs {
            let full = dir.join(&name);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

#[cfg(windows)]
fn candidate_names(program: &str) -> Vec<String> {
    if Path::new(program).extension().is_some() {
        return vec![program.to_owned()];
    }
    // Extension-major (not the dir-major CreateProcess order): a native
    // .exe anywhere on PATH beats a .cmd shim, because argv can be
    // passed to an .exe verbatim while batch files re-parse it.
    let pathext =
        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned());
    let (mut exes, mut shims): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    for ext in pathext.split(';').filter(|e| !e.is_empty()) {
        let name = format!("{program}{ext}");
        if ext.eq_ignore_ascii_case(".bat") || ext.eq_ignore_ascii_case(".cmd") {
            shims.push(name);
        } else {
            exes.push(name);
        }
    }
    exes.extend(shims);
    exes
}

#[cfg(not(windows))]
fn candidate_names(program: &str) -> Vec<String> {
    vec![program.to_owned()]
}

/// Spawn the program directly — never through `cmd /C`. Arguments here
/// include repo-controlled strings (branch names, file paths) and raw
/// prompts; handing them to `cmd.exe` lets metacharacters (`&`, `|`,
/// `"`) break out into arbitrary commands. Spawning the resolved
/// absolute path keeps argv intact for `.exe`s, and for `.cmd`/`.bat`
/// shims Rust applies strict batch escaping and refuses arguments it
/// cannot make safe — failing closed instead of injecting.
#[cfg(windows)]
pub fn os_command(program: &str, args: &[String]) -> Command {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let resolved = resolve_program(program).unwrap_or_else(|| PathBuf::from(program));
    let mut cmd = Command::new(resolved);
    cmd.args(args);
    // Children that themselves shell out must not resolve programs from
    // our cwd either (it is the untrusted project folder).
    cmd.env("NoDefaultCurrentDirectoryInExePath", "1");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(windows))]
pub fn os_command(program: &str, args: &[String]) -> Command {
    let resolved = resolve_program(program).unwrap_or_else(|| PathBuf::from(program));
    let mut cmd = Command::new(resolved);
    cmd.args(args);
    cmd
}

/// Pump the child's output through the provider parser until it exits,
/// then guarantee exactly one `TurnCompleted` reaches the frontend.
pub async fn stream_turn(
    app: AppHandle,
    tab_id: String,
    provider: &'static dyn Provider,
    mut child: Child,
) {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Drain stderr concurrently with stdout: a child that fills the
    // ~64 KB stderr pipe while we are still reading stdout would block
    // on its next stderr write and the whole turn would deadlock.
    let stderr_task = stderr.map(|stderr| {
        tokio::spawn(async move {
            let mut text = String::new();
            let _ = stderr
                .take(MAX_CAPTURE_BYTES as u64)
                .read_to_string(&mut text)
                .await;
            text
        })
    });

    let wants_full_output = provider.wants_full_output();
    let mut full_output = String::new();
    let mut emitted_message = false;
    let mut completed = false;

    if let Some(stdout) = stdout {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if wants_full_output && full_output.len() < MAX_CAPTURE_BYTES {
                full_output.push_str(&line);
                full_output.push('\n');
            }
            for event in provider.parse_line(&line) {
                track(&event, &mut emitted_message, &mut completed);
                emit(&app, &tab_id, &event);
            }
        }
    }

    let stderr_text = match stderr_task {
        Some(task) => task.await.unwrap_or_default(),
        None => String::new(),
    };
    let status = child.wait().await;

    for event in provider.parse_final(&full_output, emitted_message) {
        track(&event, &mut emitted_message, &mut completed);
        emit(&app, &tab_id, &event);
    }

    if !completed {
        let ok = status.map(|s| s.success()).unwrap_or(false);
        let result = if ok { None } else { Some(failure_summary(&stderr_text)) };
        emit(
            &app,
            &tab_id,
            &AgentEvent::TurnCompleted {
                result,
                provider_session_id: None,
                is_error: !ok,
                stop_reason: None,
            },
        );
    }
}

fn track(event: &AgentEvent, emitted_message: &mut bool, completed: &mut bool) {
    match event {
        AgentEvent::AssistantMessage { .. } => *emitted_message = true,
        AgentEvent::TurnCompleted { .. } => *completed = true,
        _ => {}
    }
}

fn failure_summary(stderr_text: &str) -> String {
    let tail: String = stderr_text
        .lines()
        .rev()
        .take(5)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    if tail.trim().is_empty() {
        "The agent process exited with an error.".to_owned()
    } else {
        tail
    }
}
