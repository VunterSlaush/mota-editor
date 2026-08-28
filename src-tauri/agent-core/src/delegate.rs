//! Handing a slash command off to a sub-agent — pure prompt composition.
//!
//! Every provider ships sub-agents, and every one addresses them
//! differently. That difference lives here, next to `agent_env` and
//! `scope_preamble`, for the reason the coding standards give: a use
//! case that branched on `provider_id` would have to be edited every
//! time a vendor is added. The domain decides THAT a command is
//! delegated and to whom; this module decides how to say it.
//!
//! Two facts shape every line below, both verified against the shipping
//! CLIs rather than assumed:
//!
//! 1. Claude's expander matches `@"<name> (agent)"` against
//!    `(^|[\s。、？！])@"([\w:.@-]+) \(agent\)"` — so the mention must
//!    open the prompt or follow whitespace, with exactly one space
//!    before `(agent)`. A name it cannot resolve is dropped SILENTLY,
//!    leaving the rest of the prompt to run inline at full price. That
//!    is why the sentence after the mention has to stand on its own as
//!    an instruction: when the mention is dropped, it is all that is
//!    left, and it must still say something sensible.
//! 2. A slash command is NOT expanded inside a sub-agent. The child
//!    receives the literal text, so it has to be told to go and read the
//!    command's own definition.

use crate::turn::TurnRequest;

/// What a turn actually sends: the delegation when the tab's command was
/// handed off to a sub-agent, the typed text otherwise. The single entry
/// point, called by both prompt paths.
pub fn outgoing_prompt(provider_id: &str, request: &TurnRequest) -> String {
    let Some(agent) = request.delegate_to.as_deref().map(str::trim).filter(|a| !a.is_empty())
    else {
        return request.prompt.clone();
    };
    let (command, args) = split_leading_command(&request.prompt);
    delegation_prompt(provider_id, agent, command, args, request.handoff.as_deref())
}

/// The prompt's leading token and everything after it. The domain only
/// sets `delegate_to` when the prompt starts with a slash command, so
/// that token is the command by construction.
fn split_leading_command(prompt: &str) -> (&str, &str) {
    let trimmed = prompt.trim();
    match trimmed.find(char::is_whitespace) {
        Some(at) => (&trimmed[..at], trimmed[at..].trim_start()),
        None => (trimmed, ""),
    }
}

/// The prompt that hands `command` to `agent`, with the arguments the
/// user typed and an optional hand-off from the conversation.
///
/// `agent` is assumed addressable — the domain refuses names outside
/// `[\w:.@-]` before it gets here, because an unaddressable one would
/// produce a mention that silently does nothing.
pub fn delegation_prompt(
    provider_id: &str,
    agent: &str,
    command: &str,
    args: &str,
    handoff: Option<&str>,
) -> String {
    let mut prompt = String::new();

    // Codex and opencode have no mention grammar — each resolves an
    // agent by name inside its own task tool, so the name goes in prose.
    match provider_id {
        "claude" => prompt.push_str(&format!("@\"{agent} (agent)\" ")),
        "gemini" => prompt.push_str(&format!("@{agent} ")),
        _ => {}
    }

    if matches!(provider_id, "codex" | "opencode") {
        prompt.push_str(&format!("Have the {agent} agent carry out this project's "));
    } else {
        prompt.push_str("Carry out this project's ");
    }
    prompt.push_str(&format!("{command} command."));

    prompt.push_str(
        "\n\nSlash commands are not expanded for you, so find the definition of \
         this one among the project's own commands and skills and follow it \
         exactly. Report only the outcome — the work itself stays with you.",
    );

    let args = args.trim();
    if !args.is_empty() {
        prompt.push_str(&format!("\n\nArguments: {args}"));
    }

    if let Some(handoff) = handoff.map(str::trim).filter(|h| !h.is_empty()) {
        prompt.push_str(&format!(
            "\n\nRecent conversation, for context you would otherwise be missing:\n{handoff}"
        ));
    }

    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Claude's own expander, copied from the binary (2.1.139). Any
    /// change to the mention above must keep matching this.
    fn claude_mention_matches(prompt: &str, agent: &str) -> bool {
        let expected = format!("@\"{agent} (agent)\"");
        // Start-of-string counts as a valid boundary, and that is where
        // we always put it.
        prompt.starts_with(&expected)
    }

    #[test]
    fn claude_opens_with_a_resolvable_mention() {
        let prompt = delegation_prompt("claude", "mota-commit-push", "/commit-push", "", None);
        assert!(claude_mention_matches(&prompt, "mota-commit-push"));
        assert!(prompt.contains("/commit-push command"));
    }

    #[test]
    fn gemini_uses_its_own_at_prefix() {
        let prompt = delegation_prompt("gemini", "generalist", "/commit-push", "", None);
        assert!(prompt.starts_with("@generalist "));
        assert!(!prompt.contains("(agent)"));
    }

    #[test]
    fn codex_names_the_agent_in_prose() {
        let prompt = delegation_prompt("codex", "worker", "/commit-push", "", None);
        assert!(!prompt.starts_with('@'));
        assert!(prompt.contains("Have the worker agent"));
    }

    #[test]
    fn opencode_names_the_agent_in_prose_too() {
        // Its `@` is for files, not agents — a mention here would be
        // read as a path and the delegation would quietly not happen.
        let prompt = delegation_prompt("opencode", "general", "/commit-push", "", None);
        assert!(!prompt.starts_with('@'));
        assert!(prompt.contains("Have the general agent"));
    }

    #[test]
    fn the_instruction_survives_a_dropped_mention() {
        // Everything after the mention must read as a complete request,
        // because a mention Claude cannot resolve is silently removed.
        let prompt = delegation_prompt("claude", "missing", "/commit-push", "", None);
        let without_mention = prompt.replace("@\"missing (agent)\" ", "");
        assert!(without_mention.starts_with("Carry out this project's /commit-push command."));
    }

    #[test]
    fn tells_the_child_to_resolve_the_command_itself() {
        // Verified: a slash command does not expand inside a sub-agent.
        let prompt = delegation_prompt("claude", "a", "/commit-push", "", None);
        assert!(prompt.contains("not expanded for you"));
    }

    #[test]
    fn arguments_are_included_only_when_there_are_some() {
        let with = delegation_prompt("claude", "a", "/commit-push", " fix the parser ", None);
        assert!(with.contains("Arguments: fix the parser"));
        let without = delegation_prompt("claude", "a", "/commit-push", "   ", None);
        assert!(!without.contains("Arguments:"));
    }

    #[test]
    fn the_handoff_is_included_only_when_there_is_one() {
        let with = delegation_prompt(
            "claude",
            "a",
            "/commit-push",
            "",
            Some("User: fix the parser"),
        );
        assert!(with.contains("Recent conversation"));
        assert!(with.contains("User: fix the parser"));

        for empty in [None, Some(""), Some("   ")] {
            let prompt = delegation_prompt("claude", "a", "/commit-push", "", empty);
            assert!(!prompt.contains("Recent conversation"));
        }
    }

    #[test]
    fn an_unknown_provider_still_produces_a_usable_instruction() {
        let prompt = delegation_prompt("newvendor", "a", "/commit-push", "", None);
        assert!(prompt.starts_with("Carry out this project's /commit-push command."));
    }

    #[test]
    fn a_turn_with_no_delegation_sends_the_typed_text_untouched() {
        let request = crate::turn::test_request("just fix the parser");
        assert_eq!(outgoing_prompt("claude", &request), "just fix the parser");
    }

    #[test]
    fn a_delegated_turn_splits_the_command_from_its_arguments() {
        let request = TurnRequest {
            delegate_to: Some("mota-commit-push".to_owned()),
            ..crate::turn::test_request("/commit-push fix the parser")
        };
        let prompt = outgoing_prompt("claude", &request);
        assert!(prompt.starts_with("@\"mota-commit-push (agent)\" "));
        assert!(prompt.contains("/commit-push command"));
        assert!(prompt.contains("Arguments: fix the parser"));
    }

    #[test]
    fn a_delegated_command_with_no_arguments_is_handled() {
        let request = TurnRequest {
            delegate_to: Some("a".to_owned()),
            ..crate::turn::test_request("/commit-push")
        };
        let prompt = outgoing_prompt("claude", &request);
        assert!(prompt.contains("/commit-push command"));
        assert!(!prompt.contains("Arguments:"));
    }

    #[test]
    fn an_empty_agent_name_is_treated_as_no_delegation() {
        let request = TurnRequest {
            delegate_to: Some("   ".to_owned()),
            ..crate::turn::test_request("/commit-push")
        };
        assert_eq!(outgoing_prompt("claude", &request), "/commit-push");
    }
}
