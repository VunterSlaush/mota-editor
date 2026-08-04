//! Process runner — spawns a provider's CLI for one turn and streams its
//! stdout through the provider's parser, emitting domain events to the
//! frontend. The only file that touches child processes.

use std::path::Path;
use std::process::Stdio;

use agent_core::{AgentEvent, Provider, TurnCommand};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WireEvent<'a> {
    tab_id: &'a str,
    event: &'a AgentEvent,
}

pub const EVENT_CHANNEL: &str = "agent-event";

pub fn emit(app: &AppHandle, tab_id: &str, event: &AgentEvent) {
    let _ = app.emit(EVENT_CHANNEL, WireEvent { tab_id, event });
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

/// On Windows, CLIs installed via npm are `.cmd` shims that only `cmd /C`
/// can resolve; also suppress the console window.
#[cfg(windows)]
pub fn os_command(program: &str, args: &[String]) -> Command {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new("cmd");
    cmd.arg("/C").arg(program).args(args);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(windows))]
pub fn os_command(program: &str, args: &[String]) -> Command {
    let mut cmd = Command::new(program);
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

    let mut full_output = String::new();
    let mut emitted_message = false;
    let mut completed = false;

    if let Some(stdout) = stdout {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            full_output.push_str(&line);
            full_output.push('\n');
            for event in provider.parse_line(&line) {
                track(&event, &mut emitted_message, &mut completed);
                emit(&app, &tab_id, &event);
            }
        }
    }

    let mut stderr_text = String::new();
    if let Some(mut stderr) = stderr {
        let _ = stderr.read_to_string(&mut stderr_text).await;
    }
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
