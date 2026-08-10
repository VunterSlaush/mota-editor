//! Which shell the user's terminal runs — the choice, not the spawning.
//!
//! Picking a shell is a small pile of platform rules that would otherwise
//! hide inside a `#[cfg]` maze in the shell crate, testable on one
//! platform at a time. Here the platform and the environment are
//! arguments, so every branch is reachable from every developer's
//! machine.
//!
//! Note the vocabulary: a `shell` is the one the *user* types into. The
//! agent's captured commands are `terminal`s (see `acp`), and the two
//! never meet.

use serde::{Deserialize, Serialize};

/// Which family of shell defaults applies. An argument rather than
/// `cfg!(windows)` so the table can be tested for both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Windows,
    Unix,
}

impl Platform {
    /// The platform this build is for.
    pub fn current() -> Self {
        if cfg!(windows) {
            Platform::Windows
        } else {
            Platform::Unix
        }
    }
}

/// A program and its arguments, ready to be resolved and spawned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSpec {
    pub program: String,
    pub args: Vec<String>,
}

impl ShellSpec {
    fn new(program: &str, args: &[&str]) -> Self {
        ShellSpec {
            program: program.to_owned(),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
        }
    }
}

/// Narrower than any real terminal, wider than any useful one. The pty
/// is told a size on every resize, and a webview mid-layout can report
/// zero or something absurd; neither should reach the kernel.
const MIN_COLS: u16 = 2;
const MIN_ROWS: u16 = 1;
const MAX_COLS: u16 = 1000;
const MAX_ROWS: u16 = 1000;

/// Shells to try, best first. The caller resolves them against PATH and
/// spawns the first that exists, because "is pwsh installed?" is a
/// question about the disk, not about policy.
///
/// A configured override wins outright and is the only candidate: if the
/// user names a shell we cannot find, that is an error worth reporting,
/// not a reason to silently hand them a different shell.
pub fn shell_candidates(
    platform: Platform,
    shell_env: Option<&str>,
    configured: Option<&str>,
) -> Vec<ShellSpec> {
    if let Some(program) = non_blank(configured) {
        return vec![ShellSpec::new(program, &[])];
    }
    match platform {
        // `-NoLogo` because a banner on every new terminal is noise the
        // user did not ask for. PowerShell 7 first, then the one that
        // ships with Windows, then the shell that is always there.
        Platform::Windows => vec![
            ShellSpec::new("pwsh.exe", &["-NoLogo"]),
            ShellSpec::new("powershell.exe", &["-NoLogo"]),
            ShellSpec::new("cmd.exe", &[]),
        ],
        // No `-l`: the child gets a real pty, so it starts interactive
        // and reads the user's rc file on its own. Forcing a login shell
        // would re-run profile scripts the desktop session already ran.
        Platform::Unix => {
            let mut candidates = Vec::new();
            if let Some(from_env) = non_blank(shell_env) {
                candidates.push(ShellSpec::new(from_env, &[]));
            }
            candidates.push(ShellSpec::new("/bin/bash", &[]));
            candidates.push(ShellSpec::new("/bin/sh", &[]));
            candidates
        }
    }
}

/// Hold a requested pty size to something a terminal could really be.
pub fn clamp_size(cols: u16, rows: u16) -> (u16, u16) {
    (cols.clamp(MIN_COLS, MAX_COLS), rows.clamp(MIN_ROWS, MAX_ROWS))
}

fn non_blank(value: Option<&str>) -> Option<&str> {
    let trimmed = value?.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn programs(specs: &[ShellSpec]) -> Vec<&str> {
        specs.iter().map(|s| s.program.as_str()).collect()
    }

    #[test]
    fn prefers_powershell_seven_on_windows_and_keeps_cmd_as_the_last_resort() {
        let specs = shell_candidates(Platform::Windows, None, None);
        assert_eq!(programs(&specs), vec!["pwsh.exe", "powershell.exe", "cmd.exe"]);
        assert_eq!(specs[0].args, vec!["-NoLogo".to_owned()]);
    }

    #[test]
    fn prefers_the_users_shell_on_unix() {
        let specs = shell_candidates(Platform::Unix, Some("/usr/bin/fish"), None);
        assert_eq!(programs(&specs), vec!["/usr/bin/fish", "/bin/bash", "/bin/sh"]);
    }

    #[test]
    fn starts_the_unix_shell_interactive_rather_than_as_a_login_shell() {
        let specs = shell_candidates(Platform::Unix, Some("/bin/zsh"), None);
        assert!(specs[0].args.is_empty());
    }

    #[test]
    fn falls_back_when_the_shell_variable_is_unset_or_blank() {
        assert_eq!(
            programs(&shell_candidates(Platform::Unix, None, None)),
            vec!["/bin/bash", "/bin/sh"]
        );
        assert_eq!(
            programs(&shell_candidates(Platform::Unix, Some("   "), None)),
            vec!["/bin/bash", "/bin/sh"]
        );
    }

    #[test]
    fn a_configured_shell_is_the_only_candidate_so_a_typo_is_reported_not_hidden() {
        let specs = shell_candidates(Platform::Windows, None, Some("C:\\bin\\nu.exe"));
        assert_eq!(programs(&specs), vec!["C:\\bin\\nu.exe"]);
    }

    #[test]
    fn ignores_a_configured_shell_that_is_only_whitespace() {
        let specs = shell_candidates(Platform::Unix, Some("/bin/zsh"), Some("  "));
        assert_eq!(programs(&specs), vec!["/bin/zsh", "/bin/bash", "/bin/sh"]);
    }

    #[test]
    fn trims_a_configured_shell_that_the_settings_field_padded() {
        let specs = shell_candidates(Platform::Unix, None, Some(" /bin/zsh "));
        assert_eq!(programs(&specs), vec!["/bin/zsh"]);
    }

    #[test]
    fn holds_a_pty_size_to_something_a_terminal_could_be() {
        assert_eq!(clamp_size(80, 24), (80, 24));
        assert_eq!(clamp_size(0, 0), (MIN_COLS, MIN_ROWS));
        assert_eq!(clamp_size(9999, 9999), (MAX_COLS, MAX_ROWS));
    }
}
