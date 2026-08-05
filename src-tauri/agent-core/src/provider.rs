use crate::event::AgentEvent;
use crate::providers::{claude::Claude, codex::Codex, gemini::Gemini};
use crate::turn::TurnRequest;

/// The command line a provider wants executed for one turn.
/// The shell (outer layer) decides how to spawn it; the provider only
/// describes it — keeping this crate free of process I/O.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// Boundary interface for one AI vendor's headless CLI.
///
/// Implementations translate between the vendor's stream format and the
/// domain's [`AgentEvent`]s. Adding a vendor means adding one adapter
/// here — nothing in the shell or the frontend core changes (OCP).
pub trait Provider: Send + Sync {
    fn id(&self) -> &'static str;

    /// Build the command for one turn from the full request: prompt,
    /// mode, permission policy, attachments, and session to resume.
    fn build_command(&self, request: &TurnRequest) -> TurnCommand;

    /// Translate one stdout line into zero or more domain events.
    fn parse_line(&self, line: &str) -> Vec<AgentEvent>;

    /// Last chance to produce events once the process has exited, given
    /// the full captured stdout. Used by providers whose output is not
    /// line-oriented. `emitted_message` tells whether any assistant
    /// message was already produced by `parse_line`.
    fn parse_final(&self, _full_output: &str, _emitted_message: bool) -> Vec<AgentEvent> {
        Vec::new()
    }

    /// Whether the runner must retain the full stdout for
    /// [`Provider::parse_final`]. Off by default so long line-oriented
    /// streams (Claude, Codex) are not accumulated in memory.
    fn wants_full_output(&self) -> bool {
        false
    }
}

/// Registry of available providers (the only place adapters are listed).
pub fn provider_for(id: &str) -> Option<&'static dyn Provider> {
    static CLAUDE: Claude = Claude;
    static CODEX: Codex = Codex;
    static GEMINI: Gemini = Gemini;
    match id {
        "claude" => Some(&CLAUDE),
        "codex" => Some(&CODEX),
        "gemini" => Some(&GEMINI),
        _ => None,
    }
}

/// Compact human-readable summary of a tool-use input object.
pub(crate) fn summarize_tool_input(input: &serde_json::Value) -> String {
    const PREFERRED_KEYS: [&str; 6] =
        ["command", "file_path", "path", "pattern", "query", "url"];
    let summary = PREFERRED_KEYS
        .iter()
        .find_map(|k| input.get(k).and_then(|v| v.as_str()).map(str::to_owned))
        .unwrap_or_else(|| input.to_string());
    truncate(&summary, 200)
}

pub(crate) fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_owned()
    } else {
        let cut: String = text.chars().take(max_chars).collect();
        format!("{cut}…")
    }
}
