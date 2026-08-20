//! Client-owned terminals for ACP `terminal/*` — the shell runs agent
//! commands, captures their merged output under a byte cap, and reports
//! exit status. Mechanical only; wire shapes live in `agent_core::acp`.
//!
//! No PTY: output is pipe capture, so fully interactive programs
//! degrade. The spec doesn't require one, and a pipe is faithful for
//! the build/test/script commands agents actually run.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

use crate::runner;

/// Retained-output cap when the agent doesn't set `outputByteLimit`.
const DEFAULT_OUTPUT_LIMIT: usize = 1_048_576;

/// How a finished command ended. `signal` stays None on Windows.
#[derive(Clone, Debug)]
pub struct ExitInfo {
    pub code: Option<i64>,
    pub signal: Option<String>,
}

struct TerminalState {
    buffer: Vec<u8>,
    truncated: bool,
    limit: usize,
    exit: Option<ExitInfo>,
}

pub struct TerminalHandle {
    pid: Option<u32>,
    state: Mutex<TerminalState>,
    exited: Notify,
}

impl TerminalHandle {
    /// Everything captured so far (lossy UTF-8), the truncation flag,
    /// and the exit status once the command finished.
    pub fn output(&self) -> (String, bool, Option<ExitInfo>) {
        let state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        (
            String::from_utf8_lossy(&state.buffer).into_owned(),
            state.truncated,
            state.exit.clone(),
        )
    }

    /// Block until the command exits (already-exited returns at once).
    pub async fn wait_for_exit(&self) -> ExitInfo {
        loop {
            // Arm the notification BEFORE checking, or an exit landing
            // between check and wait would sleep forever.
            let notified = self.exited.notified();
            if let Some(exit) = self
                .state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .exit
                .clone()
            {
                return exit;
            }
            notified.await;
        }
    }

    /// Kill the command (tree-wide on Windows); the terminal stays valid
    /// so final output can still be read.
    pub fn kill(&self) {
        let Some(pid) = self.pid else { return };
        if self
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .exit
            .is_some()
        {
            return; // already gone
        }
        // TerminateProcess reaches only the direct child; a shell's
        // grandchildren survive it. taskkill /T fells the whole tree.
        #[cfg(windows)]
        {
            let mut command = std::process::Command::new("taskkill");
            command.args(["/T", "/F", "/PID", &pid.to_string()]);
            #[allow(clippy::disallowed_methods)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            }
            // Waited on, like shell_session's: an agent terminal is
            // cwd'd into the project too, and a worktree cannot be
            // deleted out from under a process that is still running.
            let _ = command.status();
        }
        #[cfg(not(windows))]
        {
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status();
        }
    }
}

/// One session's terminals, by the ids this manager hands out.
#[derive(Default)]
pub struct TerminalManager {
    next_id: AtomicU64,
    terminals: Mutex<HashMap<String, Arc<TerminalHandle>>>,
}

impl TerminalManager {
    /// Spawn the command and start capturing; returns the terminal id.
    pub fn create(
        &self,
        command: &str,
        args: &[String],
        env: &[(String, String)],
        cwd: &str,
        output_byte_limit: Option<u64>,
    ) -> Result<String, String> {
        let mut os_command = runner::os_command(command, args);
        os_command
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (name, value) in env {
            os_command.env(name, value);
        }
        let mut child = os_command
            .spawn()
            .map_err(|e| format!("Could not run {command}: {e}"))?;

        let limit = output_byte_limit
            .and_then(|l| usize::try_from(l).ok())
            .unwrap_or(DEFAULT_OUTPUT_LIMIT);
        let handle = Arc::new(TerminalHandle {
            pid: child.id(),
            state: Mutex::new(TerminalState {
                buffer: Vec::new(),
                truncated: false,
                limit,
                exit: None,
            }),
            exited: Notify::new(),
        });

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        if let Some(stdout) = stdout {
            spawn_capture(Arc::clone(&handle), stdout);
        }
        if let Some(stderr) = stderr {
            spawn_capture(Arc::clone(&handle), stderr);
        }
        // The wait task owns the child; kill goes through the OS by pid.
        let handle_for_wait = Arc::clone(&handle);
        tauri::async_runtime::spawn(async move {
            let status = child.wait().await;
            let exit = ExitInfo {
                code: status.as_ref().ok().and_then(|s| s.code()).map(i64::from),
                signal: None,
            };
            handle_for_wait
                .state
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .exit = Some(exit);
            handle_for_wait.exited.notify_waiters();
        });

        let terminal_id = format!("term-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        self.terminals
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(terminal_id.clone(), handle);
        Ok(terminal_id)
    }

    pub fn get(&self, terminal_id: &str) -> Option<Arc<TerminalHandle>> {
        self.terminals
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(terminal_id)
            .cloned()
    }

    /// Release: kill if still running and forget the id.
    pub fn release(&self, terminal_id: &str) {
        if let Some(handle) = self
            .terminals
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(terminal_id)
        {
            handle.kill();
        }
    }

    /// Session teardown: no agent process may leave orphans behind.
    pub fn kill_all(&self) {
        for (_, handle) in self
            .terminals
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .drain()
        {
            handle.kill();
        }
    }
}

/// Append one pipe's bytes into the shared buffer, enforcing the cap.
fn spawn_capture(
    handle: Arc<TerminalHandle>,
    mut pipe: impl AsyncReadExt + Unpin + Send + 'static,
) {
    tauri::async_runtime::spawn(async move {
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut state =
                        handle.state.lock().unwrap_or_else(PoisonError::into_inner);
                    state.buffer.extend_from_slice(&chunk[..n]);
                    let limit = state.limit;
                    if agent_core::acp::drop_to_byte_limit(&mut state.buffer, limit) {
                        state.truncated = true;
                    }
                }
            }
        }
    });
}
