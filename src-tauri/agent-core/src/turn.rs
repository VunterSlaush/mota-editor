//! Turn request — the DTO every provider receives for one prompt turn,
//! plus the pure prompt-composition rules shared across providers.

use serde::Deserialize;

/// How the agent should behave for this turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Agent,
    Plan,
    Debug,
}

/// How much the agent is allowed to do without asking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Permission {
    /// Safe defaults: the CLI denies/sandboxes risky actions. (Headless
    /// runs cannot prompt interactively; see ADR-0004.)
    #[default]
    Manual,
    /// The agent runs freely and asks only about risky actions. Maps to
    /// the vendor's own auto tier where it has one (Claude's native
    /// `auto` mode); otherwise the nearest accept-edits equivalent.
    Auto,
    /// The vendor's explicit bypass flag: the agent acts without asking.
    Bypass,
}

/// Everything a provider needs to build one turn's command.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnRequest {
    pub prompt: String,
    pub project_path: String,
    pub resume_session_id: Option<String>,
    pub mode: Mode,
    pub permission: Permission,
    pub attachments: Vec<String>,
    /// Model override (vendor-specific id or alias); None = provider default.
    pub model: Option<String>,
    /// Reasoning-effort override (vendor vocabulary); None = default.
    pub effort: Option<String>,
    /// The tab's subtask scope; None for a tab with full authority.
    pub subtask: Option<crate::scope::SubtaskScope>,
}

const PLAN_PREAMBLE: &str = "You are in PLAN MODE. Do not create, modify, or delete any \
files, and do not run commands that change state. Analyze the project and produce a \
detailed step-by-step implementation plan: the files you would change, in what order, \
and why. Wait for approval before implementing anything.";

const DEBUG_PREAMBLE: &str = "You are in DEBUG MODE. Focus on diagnosing the problem \
described below: reproduce it if possible, trace the root cause, and explain your \
reasoning with evidence (logs, failing tests) before proposing a minimal, targeted fix.";

/// The instruction preamble a mode needs, given whether the transport
/// enforces plan mode natively. Debug is always a preamble — no CLI has
/// a debug concept.
pub fn mode_preamble(mode: Mode, plan_is_native: bool) -> Option<&'static str> {
    match mode {
        Mode::Agent => None,
        Mode::Debug => Some(DEBUG_PREAMBLE),
        Mode::Plan => (!plan_is_native).then_some(PLAN_PREAMBLE),
    }
}

/// Compose the prompt actually sent to the CLI: mode preamble (unless the
/// provider enforces the mode natively) + attachment note + user prompt.
pub fn effective_prompt(request: &TurnRequest, mode_is_native: bool) -> String {
    let mut parts: Vec<String> = Vec::new();

    if let Some(preamble) = mode_preamble(request.mode, mode_is_native) {
        parts.push(preamble.to_owned());
    }

    // Always stated, even where a sandbox also enforces it: vendor CLIs
    // own their tools, so the preamble is the one layer every provider
    // gets (ADR-0014).
    if let Some(scope_text) = crate::scope::scope_preamble(request.subtask.as_ref()) {
        parts.push(scope_text);
    }

    if !request.attachments.is_empty() {
        let list = request
            .attachments
            .iter()
            .map(|p| format!("- {p}"))
            .collect::<Vec<_>>()
            .join("\n");
        parts.push(format!(
            "The user attached these files (read them from disk as needed):\n{list}"
        ));
    }

    parts.push(request.prompt.clone());
    parts.join("\n\n")
}

/// Directories, outside the project folder, that hold attachments — so
/// providers that support it can grant the agent read access to them.
pub fn external_attachment_dirs(request: &TurnRequest) -> Vec<String> {
    let mut dirs: Vec<String> = Vec::new();
    for attachment in &request.attachments {
        if attachment.starts_with(&request.project_path) {
            continue;
        }
        if let Some(parent) = parent_dir(attachment) {
            if !dirs.contains(&parent) {
                dirs.push(parent);
            }
        }
    }
    dirs
}

fn parent_dir(path: &str) -> Option<String> {
    let cut = path.rfind(['/', '\\'])?;
    (cut > 0).then(|| path[..cut].to_owned())
}

#[cfg(test)]
pub fn test_request(prompt: &str) -> TurnRequest {
    TurnRequest {
        prompt: prompt.to_owned(),
        project_path: "/work/alpha".to_owned(),
        resume_session_id: None,
        mode: Mode::Agent,
        permission: Permission::Manual,
        attachments: Vec::new(),
        model: None,
        effort: None,
        subtask: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_mode_sends_the_prompt_untouched() {
        let request = test_request("hello");
        assert_eq!(effective_prompt(&request, false), "hello");
    }

    #[test]
    fn plan_mode_prepends_the_plan_preamble_when_not_native() {
        let request = TurnRequest { mode: Mode::Plan, ..test_request("add auth") };
        let prompt = effective_prompt(&request, false);
        assert!(prompt.starts_with("You are in PLAN MODE."));
        assert!(prompt.ends_with("add auth"));
    }

    #[test]
    fn plan_mode_adds_nothing_when_the_provider_is_native() {
        let request = TurnRequest { mode: Mode::Plan, ..test_request("add auth") };
        assert_eq!(effective_prompt(&request, true), "add auth");
    }

    #[test]
    fn debug_mode_prepends_the_debug_preamble_even_for_native_providers() {
        let request = TurnRequest { mode: Mode::Debug, ..test_request("it crashes") };
        assert!(effective_prompt(&request, true).starts_with("You are in DEBUG MODE."));
    }

    #[test]
    fn a_scope_is_stated_even_when_the_mode_is_native() {
        // Mode preambles stand down for a native mode; the scope never
        // does — no vendor enforces a folder boundary for us.
        let request = TurnRequest {
            subtask: Some(crate::scope::SubtaskScope::Boundary {
                boundaries: vec!["apps/web".to_owned()],
            }),
            ..test_request("edit the web app")
        };
        let prompt = effective_prompt(&request, true);
        assert!(prompt.contains("- apps/web"));
        assert!(prompt.ends_with("edit the web app"));
    }

    #[test]
    fn attachments_are_listed_before_the_prompt() {
        let request = TurnRequest {
            attachments: vec!["/tmp/spec.pdf".to_owned()],
            ..test_request("summarize this")
        };
        let prompt = effective_prompt(&request, false);
        assert!(prompt.contains("- /tmp/spec.pdf"));
        assert!(prompt.ends_with("summarize this"));
    }

    #[test]
    fn external_attachment_dirs_skips_files_inside_the_project() {
        let request = TurnRequest {
            attachments: vec![
                "/work/alpha/notes.md".to_owned(),
                "/docs/spec.pdf".to_owned(),
                "/docs/other.pdf".to_owned(),
            ],
            ..test_request("x")
        };
        assert_eq!(external_attachment_dirs(&request), vec!["/docs".to_owned()]);
    }

    #[test]
    fn mode_and_permission_deserialize_from_lowercase() {
        assert_eq!(serde_json::from_str::<Mode>("\"plan\"").unwrap(), Mode::Plan);
        assert_eq!(
            serde_json::from_str::<Permission>("\"bypass\"").unwrap(),
            Permission::Bypass
        );
        assert_eq!(
            serde_json::from_str::<Permission>("\"auto\"").unwrap(),
            Permission::Auto
        );
    }
}
