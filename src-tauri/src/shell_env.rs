//! Making a Finder-launched app see the same environment as the user's
//! terminal.
//!
//! A macOS `.app` started from Finder, Dock, or Spotlight inherits
//! launchd's environment, not a login shell's. That environment has a
//! bare `PATH` (no Homebrew, no nvm, no volta), so an agent CLI the user
//! installed and uses daily is simply invisible to us — the app reports
//! "not installed" for a tool that works fine in their terminal.
//!
//! The fix everyone converges on is to ask the login shell what it thinks
//! the environment is, once, at startup. We import `PATH` plus the
//! provider variables, so that what the app resolves and what the user's
//! terminal resolves are the same thing — including when the user's shell
//! profile is the *cause* of a problem, which is the honest behaviour: an
//! app that silently disagreed with the terminal would be unexplainable.

/// Variable prefixes worth importing beyond `PATH`: the ones that select
/// or authenticate a provider, and so decide whether a turn works.
#[cfg(target_os = "macos")]
const IMPORTED_PREFIXES: [&str; 5] =
    ["ANTHROPIC_", "CLAUDE_", "CODEX_", "GEMINI_", "OPENAI_"];

/// How long the login shell gets. Profiles that start version managers
/// can be slow; past this we give up and use what we have rather than
/// hold up the window.
#[cfg(target_os = "macos")]
const SHELL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// Import the login shell's environment into this process. No-op off
/// macOS, where the launcher already hands us the user's environment.
#[cfg(not(target_os = "macos"))]
pub fn import_login_shell_env() {}

#[cfg(target_os = "macos")]
pub fn import_login_shell_env() {
    let Some(output) = login_shell_env() else { return };
    for (key, value) in parse_env(&output) {
        if is_imported(&key) {
            // Single-threaded startup, before anything that reads the
            // environment exists — the constraint `set_var` becomes
            // `unsafe` about in edition 2024, so it must stay true if
            // this crate ever moves editions.
            std::env::set_var(key, value);
        }
    }
}

/// Run the user's login shell and capture what it considers the
/// environment. `-l` loads the login profile, `-i` the interactive one —
/// PATH edits live in either depending on the user's setup.
#[cfg(target_os = "macos")]
fn login_shell_env() -> Option<String> {
    use std::process::{Command, Stdio};
    use std::sync::mpsc;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        // `command env` bypasses any `env` function or alias a profile
        // defined; stdin is closed so an interactive shell cannot block
        // waiting for input.
        let output = Command::new(shell)
            .args(["-lic", "command env"])
            .stdin(Stdio::null())
            .output();
        let _ = tx.send(output);
    });

    match rx.recv_timeout(SHELL_TIMEOUT) {
        Ok(Ok(output)) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).into_owned())
        }
        // Shell missing, non-zero, or too slow: keep the launchd
        // environment. Worse resolution, but never a delayed window.
        _ => None,
    }
}

/// Split `env` output into pairs, dropping continuation lines from
/// multi-line values (a shell function exported into the environment) —
/// those belong to the previous variable, not to a new one.
#[cfg(target_os = "macos")]
fn parse_env(output: &str) -> Vec<(String, String)> {
    output
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(key, _)| !key.is_empty() && is_variable_name(key))
        .map(|(key, value)| (key.to_owned(), value.to_owned()))
        .collect()
}

#[cfg(target_os = "macos")]
fn is_variable_name(key: &str) -> bool {
    key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !key.starts_with(|c: char| c.is_ascii_digit())
}

#[cfg(target_os = "macos")]
fn is_imported(key: &str) -> bool {
    key == "PATH" || IMPORTED_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn reads_plain_pairs() {
        let pairs = parse_env("PATH=/usr/bin:/bin\nHOME=/Users/x\n");
        assert_eq!(
            pairs,
            vec![
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ("HOME".to_owned(), "/Users/x".to_owned()),
            ]
        );
    }

    #[test]
    fn ignores_continuation_lines_of_an_exported_function() {
        let pairs = parse_env("BASH_FUNC_x%%=() {\n  echo hi=there\n}\nPATH=/bin\n");
        let keys: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["PATH"]);
    }

    #[test]
    fn imports_path_and_provider_variables_only() {
        assert!(is_imported("PATH"));
        assert!(is_imported("ANTHROPIC_API_KEY"));
        assert!(is_imported("CLAUDE_CODE_OAUTH_TOKEN"));
        assert!(!is_imported("HOME"));
        assert!(!is_imported("LC_ALL"));
    }
}
