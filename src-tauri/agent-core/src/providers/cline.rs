use serde_json::Value;

use crate::event::AgentEvent;
use crate::provider::{Provider, TurnCommand};
use crate::scope::effective_permission;
use crate::turn::{effective_prompt, Permission, TurnRequest};

/// Adapter for the Cline CLI in headless mode:
/// `cline --json --auto-approve <bool> [-m <model>] [--thinking <effort>] <prompt>`
///
/// This is the FALLBACK path. Cline speaks ACP from the same binary
/// (`cline --acp`), so this only runs when the installed version cannot
/// complete the ACP handshake — in practice, an outdated install.
///
/// `--auto-approve` is always passed explicitly, never left to default:
/// the CLI's own default is `true`, and inheriting that would let a tab
/// set to Manual act without asking on a path that has no way to ask.
///
/// The stream is one JSON object per line. Only the terminal
/// `agent_event`/`done` is read: it carries `text` and `reason`, which is
/// the whole of what a one-shot turn needs. The incremental event names
/// are deliberately not guessed — a parser invented for a shape we have
/// not captured would swallow the reply the day it drifted, so anything
/// unrecognised falls through to [`Provider::parse_final`], which prints
/// what the CLI actually said.
pub struct Cline;

impl Provider for Cline {
    fn id(&self) -> &'static str {
        "cline"
    }

    fn build_command(&self, request: &TurnRequest) -> TurnCommand {
        // Scope caps first: a scoped tab never auto-approves (ADR-0014).
        let auto_approve =
            effective_permission(request.permission, request.subtask.as_ref())
                == Permission::Bypass;
        let mut args = vec![
            "--json".to_owned(),
            "--auto-approve".to_owned(),
            auto_approve.to_string(),
        ];
        if let Some(model) = request.model.as_deref() {
            args.push("--model".to_owned());
            args.push(model.to_owned());
        }
        if let Some(effort) = request.effort.as_deref() {
            args.push("--thinking".to_owned());
            args.push(effort.to_owned());
        }
        // Prompt last: it is a positional, and anything after it would be
        // read as more of the message.
        args.push(effective_prompt(request, "cline", false));
        TurnCommand { program: "cline".to_owned(), args }
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            return Vec::new();
        };
        if value.get("type").and_then(Value::as_str) != Some("agent_event") {
            return Vec::new();
        }
        let Some(event) = value.get("event") else { return Vec::new() };
        if event.get("type").and_then(Value::as_str) != Some("done") {
            return Vec::new();
        }
        let text = event.get("text").and_then(Value::as_str).unwrap_or_default().trim();
        if text.is_empty() {
            return Vec::new();
        }
        if event.get("reason").and_then(Value::as_str) == Some("error") {
            return vec![AgentEvent::ErrorOccurred {
                message: text.to_owned(),
                context: None,
                stderr_tail: None,
            }];
        }
        vec![AgentEvent::AssistantMessage { text: text.to_owned() }]
    }

    fn wants_full_output(&self) -> bool {
        true // so a build whose stream we cannot read still gets its reply out
    }

    fn parse_final(&self, full_output: &str, emitted_message: bool) -> Vec<AgentEvent> {
        // Only reached when no `done` event was recognised; the raw text
        // is then the best available reading of the turn.
        if full_output.lines().any(|line| line.trim_start().starts_with('{')) {
            return Vec::new();
        }
        super::plain_text_reply(full_output, emitted_message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::scope::SubtaskScope;
    use crate::turn::test_request;

    // Captured from cline 3.0.55 (`cline --json`).
    const HOOK_EVENT: &str = r#"{"ts":"2026-08-20T18:21:30.392Z","type":"hook_event","hookEventName":"agent_start","agentId":"agent_1787250090245_pqsoac","taskId":"conv_1787250090381_5tpigi8","parentAgentId":null}"#;
    const ITERATION_START: &str = r#"{"ts":"2026-08-20T18:21:30.395Z","type":"agent_event","event":{"type":"iteration_start","iteration":1}}"#;
    const DONE_ERROR: &str = r#"{"ts":"2026-08-20T18:21:31.465Z","type":"agent_event","event":{"type":"done","reason":"error","text":"Unauthorized: Please make sure you're using the latest version of Cline and re-authenticate your Cline account.","iterations":1,"usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalCost":0}}}"#;
    const DONE_OK: &str = r#"{"ts":"2026-08-20T18:21:31.465Z","type":"agent_event","event":{"type":"done","reason":"stop","text":"All set.","iterations":2,"usage":{"inputTokens":10,"outputTokens":4,"cacheReadTokens":0,"cacheWriteTokens":0,"totalCost":0}}}"#;

    #[test]
    fn builds_a_json_command_with_the_prompt_last() {
        let cmd = Cline.build_command(&test_request("hi"));
        assert_eq!(cmd.program, "cline");
        assert_eq!(cmd.args, vec!["--json", "--auto-approve", "false", "hi"]);
    }

    #[test]
    fn model_and_effort_become_flags() {
        let request = TurnRequest {
            model: Some("kimi-k2.5".to_owned()),
            effort: Some("high".to_owned()),
            ..test_request("hi")
        };
        let args = Cline.build_command(&request).args;
        assert!(args.windows(2).any(|w| w == ["--model", "kimi-k2.5"]));
        assert!(args.windows(2).any(|w| w == ["--thinking", "high"]));
        assert_eq!(args.last().unwrap(), "hi");
    }

    #[test]
    fn auto_approval_is_always_stated_and_only_bypass_grants_it() {
        // Cline defaults --auto-approve to true. Leaving it unsaid would
        // let a Manual tab act unattended on a path that cannot ask.
        for (permission, expected) in [
            (Permission::Manual, "false"),
            (Permission::Auto, "false"),
            (Permission::Bypass, "true"),
        ] {
            let request = TurnRequest { permission, ..test_request("go") };
            let args = Cline.build_command(&request).args;
            assert!(
                args.windows(2).any(|w| w == ["--auto-approve", expected]),
                "{permission:?} produced {args:?}"
            );
        }
    }

    #[test]
    fn a_read_only_subtask_never_auto_approves_and_states_the_scope() {
        let request = TurnRequest {
            permission: Permission::Bypass,
            subtask: Some(SubtaskScope::ReadOnly),
            ..test_request("look around")
        };
        let args = Cline.build_command(&request).args;
        assert!(args.windows(2).any(|w| w == ["--auto-approve", "false"]));
        assert!(args.last().unwrap().contains("READ-ONLY"));
    }

    #[test]
    fn the_done_event_carries_the_reply() {
        assert_eq!(
            Cline.parse_line(DONE_OK),
            vec![AgentEvent::AssistantMessage { text: "All set.".into() }]
        );
    }

    #[test]
    fn a_failed_turn_becomes_an_error_rather_than_a_reply() {
        let events = Cline.parse_line(DONE_ERROR);
        assert_eq!(
            events,
            vec![AgentEvent::ErrorOccurred {
                message: "Unauthorized: Please make sure you're using the latest version \
                          of Cline and re-authenticate your Cline account."
                    .into(),
                context: None,
                stderr_tail: None,
            }]
        );
    }

    #[test]
    fn bookkeeping_lines_and_junk_produce_nothing() {
        assert!(Cline.parse_line(HOOK_EVENT).is_empty());
        assert!(Cline.parse_line(ITERATION_START).is_empty());
        assert!(Cline.parse_line("{ not json").is_empty());
        assert!(Cline.parse_line("").is_empty());
    }

    #[test]
    fn plain_text_output_still_yields_a_reply() {
        assert_eq!(
            Cline.parse_final("just plain words\n", false),
            vec![AgentEvent::AssistantMessage { text: "just plain words".into() }]
        );
    }

    #[test]
    fn a_json_stream_is_never_replayed_as_raw_text() {
        // The `done` event was read (or deliberately ignored); dumping the
        // whole JSON transcript underneath it would be noise, not a reply.
        let stream = format!("{HOOK_EVENT}\n{DONE_OK}\n");
        assert!(Cline.parse_final(&stream, true).is_empty());
        assert!(Cline.parse_final(&stream, false).is_empty());
    }
}
