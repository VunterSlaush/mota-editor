//! Opening a terminal so the user can sign in to a provider CLI.
//!
//! The credential store belongs to the vendor's CLI — macOS Keychain for
//! Claude, the CLI's own config elsewhere — so the app never handles
//! tokens. It only puts the user in front of the right prompt, because
//! "run `claude auth login` in a terminal" is not an instruction a
//! desktop app should be giving.
//!
//! Everything spawned here comes from `acp::sign_in_command`, a table of
//! compile-time constants. No project, prompt, or user string reaches a
//! shell — which is what makes the `osascript`/`start` string-building
//! below safe, unlike the argv-only rule the rest of the app follows.

use std::process::{Command, Stdio};

use agent_core::acp::{self, SignInCommand};

#[tauri::command]
pub fn open_provider_login(provider_id: String) -> Result<(), String> {
    let command = acp::sign_in_command(&provider_id)
        .ok_or_else(|| format!("No sign-in command is known for {provider_id}."))?;
    open_terminal(&command)
}

#[cfg(target_os = "macos")]
fn open_terminal(command: &SignInCommand) -> Result<(), String> {
    let script = format!(
        r#"tell application "Terminal"
            activate
            do script "{}"
        end tell"#,
        command.display()
    );
    spawn(Command::new("osascript").arg("-e").arg(script))
}

#[cfg(target_os = "windows")]
fn open_terminal(command: &SignInCommand) -> Result<(), String> {
    // `/k` keeps the window open after the CLI exits, so a login error is
    // readable instead of vanishing with the console.
    let mut cmd = Command::new("cmd.exe");
    cmd.args(["/c", "start", "Sign in", "cmd.exe", "/k", command.program]);
    cmd.args(command.args);
    spawn(&mut cmd)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal(command: &SignInCommand) -> Result<(), String> {
    // No standard terminal on Linux — try the usual suspects in order and
    // report honestly if the desktop has none of them.
    const TERMINALS: [&str; 5] = [
        "x-terminal-emulator",
        "gnome-terminal",
        "konsole",
        "xfce4-terminal",
        "xterm",
    ];
    for terminal in TERMINALS {
        if crate::runner::resolve_program(terminal).is_none() {
            continue;
        }
        let mut cmd = Command::new(terminal);
        cmd.arg("-e").arg(command.program).args(command.args);
        if spawn(&mut cmd).is_ok() {
            return Ok(());
        }
    }
    Err(format!(
        "Could not find a terminal to open. Run `{}` yourself to sign in.",
        command.display()
    ))
}

/// Detach the terminal: it outlives this call, and its streams must not
/// be tied to ours or the app would block on a pipe nobody drains.
fn spawn(command: &mut Command) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Could not open a terminal: {e}"))
}
