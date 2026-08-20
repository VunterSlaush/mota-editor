use crate::event::AgentEvent;

pub mod claude;
pub mod cline;
pub mod codex;
pub mod gemini;
pub mod opencode;

/// Everything the CLI printed, as one assistant message — the last-resort
/// reading of a stream whose structure we could not use. Silence stays
/// silence, and a turn that already spoke is left alone.
pub(crate) fn plain_text_reply(
    full_output: &str,
    emitted_message: bool,
) -> Vec<AgentEvent> {
    if emitted_message {
        return Vec::new();
    }
    let text = full_output.trim();
    if text.is_empty() {
        Vec::new()
    } else {
        vec![AgentEvent::AssistantMessage { text: text.to_owned() }]
    }
}
