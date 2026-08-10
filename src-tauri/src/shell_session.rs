//! The user's terminal — one real pty per session.
//!
//! Distinct from `terminal.rs`, which captures what the *agent* runs
//! through pipes. This is the shell a human types into, so it needs the
//! things a pipe cannot give: a tty (programs colourise and draw
//! progress only when they see one), a size that changes when the panel
//! is dragged, and a path for keystrokes to travel back down.
//!
//! Against the argv-only rule the rest of the app follows: we still
//! never build a command string. The shell binary is resolved on PATH by
//! `runner::resolve_program` and spawned with an argv vector, exactly
//! like every other child. What the user types afterwards goes to the
//! pty as bytes and is the shell's business, not ours — the app never
//! composes it. See docs/adr/0009.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use agent_core::shell::{clamp_size, shell_candidates, Platform};
use base64::Engine as _;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// One topic for every session, with the id as discriminator — the same
/// shape as `runner::EVENT_CHANNEL`, so the frontend keeps one listener.
pub const SHELL_EVENT: &str = "shell-event";

/// A single read from the pty. Large enough that a burst of output does
/// not turn into a syscall per line.
const READ_CHUNK: usize = 8 * 1024;
/// Flush a batch once it reaches this much, however fast output arrives.
const FLUSH_BYTES: usize = 64 * 1024;
/// …or once this long has passed, so a slow producer still gets through.
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShellWireEvent<'a> {
    session_id: &'a str,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
}

struct ShellSession {
    project_id: String,
    /// Held for resize only; the reader and writer are cloned out of it.
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
}

impl ShellSession {
    fn write(&self, data: &[u8]) -> Result<(), String> {
        let mut writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|e| format!("The terminal stopped accepting input: {e}"))
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let (cols, rows) = clamp_size(cols, rows);
        self.master
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("Could not resize the terminal: {e}"))
    }

    /// Kill the shell and everything it started. Closing the pty alone
    /// would leave a `npm run dev` grandchild running; the shell's own
    /// children are the whole point of a terminal, so the tree goes.
    fn kill(&self) {
        if let Some(pid) = self.pid {
            kill_tree(pid);
        }
        let _ = self.killer.lock().unwrap_or_else(PoisonError::into_inner).kill();
    }
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    // TerminateProcess reaches only the direct child; taskkill /T fells
    // the whole tree (same reasoning as terminal.rs).
    let mut command = std::process::Command::new("taskkill");
    command.args(["/T", "/F", "/PID", &pid.to_string()]);
    #[allow(clippy::disallowed_methods)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let _ = command.spawn();
}

#[cfg(not(windows))]
fn kill_tree(pid: u32) {
    // Negative pid means "the process group", which a pty session leader
    // heads — that is the shell plus everything it started.
    let _ = std::process::Command::new("kill")
        .args(["-9", &format!("-{pid}")])
        .spawn();
}

/// Every live terminal, by the ids this manager hands out.
#[derive(Default)]
pub struct ShellSessions {
    next_id: AtomicU64,
    map: Mutex<HashMap<String, Arc<ShellSession>>>,
}

impl ShellSessions {
    fn get(&self, session_id: &str) -> Result<Arc<ShellSession>, String> {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session_id)
            .cloned()
            .ok_or_else(|| "That terminal is no longer open.".to_owned())
    }

    /// Forget a session that has already exited on its own. Kills
    /// nothing: the shell is gone, and its id must not be reused.
    fn forget(&self, session_id: &str) {
        self.map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(session_id);
    }

    fn close(&self, session_id: &str) {
        if let Some(session) = self
            .map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(session_id)
        {
            session.kill();
        }
    }

    /// A project's tab is closing, or its worktree is being removed —
    /// on Windows a live shell holds a handle on its cwd, so this has to
    /// happen before anything tries to delete the folder.
    pub fn close_project(&self, project_id: &str) {
        let doomed: Vec<Arc<ShellSession>> = {
            let mut map = self.map.lock().unwrap_or_else(PoisonError::into_inner);
            let ids: Vec<String> = map
                .iter()
                .filter(|(_, s)| s.project_id == project_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| map.remove(id)).collect()
        };
        for session in doomed {
            session.kill();
        }
    }

    /// App teardown: no terminal may leave orphans behind.
    pub fn kill_all(&self) {
        let doomed: Vec<Arc<ShellSession>> = self
            .map
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .drain()
            .map(|(_, session)| session)
            .collect();
        for session in doomed {
            session.kill();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOpenArgs {
    pub project_id: String,
    pub cwd: String,
    /// The shell configured in Settings, if any. A program path only —
    /// it is resolved and spawned, never interpolated into a string.
    pub shell_path: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[tauri::command]
pub async fn shell_open(
    app: AppHandle,
    sessions: State<'_, ShellSessions>,
    args: ShellOpenArgs,
) -> Result<String, String> {
    let candidates = shell_candidates(
        Platform::current(),
        std::env::var("SHELL").ok().as_deref(),
        args.shell_path.as_deref(),
    );
    let (spec, program) = candidates
        .iter()
        .find_map(|spec| {
            crate::runner::resolve_program(&spec.program).map(|path| (spec, path))
        })
        .ok_or_else(|| {
            let tried: Vec<&str> = candidates.iter().map(|s| s.program.as_str()).collect();
            format!(
                "Could not find a shell to run (tried {}). Name one in Settings → Terminal.",
                tried.join(", ")
            )
        })?;

    let (cols, rows) = clamp_size(args.cols, args.rows);
    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("Could not open a terminal: {e}"))?;

    let mut command = CommandBuilder::new(&program);
    for arg in &spec.args {
        command.arg(arg);
    }
    // `CommandBuilder::new` already carries this process's environment
    // over, which is the one we want: on macOS it is the login shell's
    // PATH, imported at startup by `shell_env`.
    //
    // What the shell should believe it is talking to. xterm.js implements
    // xterm's escape sequences, so saying anything else invites a program
    // to draw something it cannot render.
    command.env("TERM", "xterm-256color");
    command.cwd(&args.cwd);

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("Could not start {}: {e}", program.display()))?;
    // The slave side must close here, or the master never sees EOF when
    // the shell exits and the reader thread would hang forever.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Could not read from the terminal: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Could not write to the terminal: {e}"))?;

    let session_id = format!("shell-{}", sessions.next_id.fetch_add(1, Ordering::SeqCst));
    let session = Arc::new(ShellSession {
        project_id: args.project_id,
        pid: child.process_id(),
        killer: Mutex::new(child.clone_killer()),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
    });
    sessions
        .map
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(session_id.clone(), Arc::clone(&session));

    // A real thread, not a task: portable-pty's reader blocks, and one
    // blocked read would otherwise hold a runtime worker hostage.
    let reader_app = app.clone();
    let reader_id = session_id.clone();
    std::thread::spawn(move || {
        pump_output(&reader_app, &reader_id, reader);
        let code = child.wait().ok().map(|status| status.exit_code() as i32);
        // The shell is already gone, so drop the handle before telling
        // the UI: a close arriving right after exit must not find a
        // session whose pid now belongs to something else.
        reader_app.state::<ShellSessions>().forget(&reader_id);
        emit(&reader_app, &reader_id, "exit", None, code);
    });

    Ok(session_id)
}

#[tauri::command]
pub async fn shell_write(
    sessions: State<'_, ShellSessions>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    sessions.get(&session_id)?.write(data.as_bytes())
}

#[tauri::command]
pub async fn shell_resize(
    sessions: State<'_, ShellSessions>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    sessions.get(&session_id)?.resize(cols, rows)
}

#[tauri::command]
pub async fn shell_close(
    sessions: State<'_, ShellSessions>,
    session_id: String,
) -> Result<(), String> {
    sessions.close(&session_id);
    Ok(())
}

#[tauri::command]
pub async fn shell_close_project(
    sessions: State<'_, ShellSessions>,
    project_id: String,
) -> Result<(), String> {
    sessions.close_project(&project_id);
    Ok(())
}

/// Forward the pty's bytes until it closes, batching where batching is
/// free.
///
/// The heuristic that keeps typing responsive: a read that came back
/// short drained the pty, so there is nothing to wait for and the batch
/// goes out at once. Only a read that filled the buffer suggests more is
/// coming, and that is the case worth coalescing — a build log becomes a
/// few dozen messages instead of a few thousand.
fn pump_output(app: &AppHandle, session_id: &str, mut reader: Box<dyn Read + Send>) {
    let mut chunk = [0u8; READ_CHUNK];
    let mut pending: Vec<u8> = Vec::with_capacity(FLUSH_BYTES);
    let mut last_flush = Instant::now();

    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        pending.extend_from_slice(&chunk[..read]);
        let drained = read < READ_CHUNK;
        if drained || pending.len() >= FLUSH_BYTES || last_flush.elapsed() >= FLUSH_INTERVAL {
            flush(app, session_id, &mut pending);
            last_flush = Instant::now();
        }
    }
    flush(app, session_id, &mut pending);
}

fn flush(app: &AppHandle, session_id: &str, pending: &mut Vec<u8>) {
    if pending.is_empty() {
        return;
    }
    // Base64, not a string: a chunk boundary lands mid-UTF-8 constantly,
    // and lossy conversion here would turn a two-byte character into two
    // replacement glyphs. xterm.js stitches the bytes back together.
    let data = base64::engine::general_purpose::STANDARD.encode(&pending);
    emit(app, session_id, "output", Some(data), None);
    pending.clear();
}

fn emit(
    app: &AppHandle,
    session_id: &str,
    kind: &'static str,
    data: Option<String>,
    exit_code: Option<i32>,
) {
    let _ = app.emit(SHELL_EVENT, ShellWireEvent { session_id, kind, data, exit_code });
}
