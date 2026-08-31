use serde_json::Value;

use crate::event::AgentEvent;
use crate::provider::{Provider, TurnCommand};
use crate::scope::effective_permission;
use crate::turn::{effective_prompt, Permission, TurnRequest};

/// Adapter for the GitHub Copilot CLI in headless mode:
/// `copilot -p <prompt> --output-format json --no-color [--allow-all-tools]
/// [--model <model>] [--effort <level>]`
///
/// This is the FALLBACK path. Copilot speaks ACP from the same binary
/// (`copilot --acp`), so this only runs when the installed version cannot
/// complete the ACP handshake — ACP is a public preview there, so unlike
/// the other providers this fallback is expected to see real use.
///
/// `--allow-all-tools` is passed ONLY for Bypass. The CLI's own help
/// calls it "required for non-interactive mode", which is a strong pull
/// towards always sending it — and the exact trade the app must refuse: a
/// tab set to Manual would then act unattended on a path that has no way
/// to ask. A Manual or Auto turn here can read but will be refused its
/// tool calls, which is the failure the user can see and correct.
///
/// The stream is one JSON object per line, each `{type, data, ...}`.
/// Only `assistant.message` and `session.error` are read; the rest is
/// bookkeeping (`model.*`, `session.mcp_*`, `assistant.turn_*`) and the
/// terminal `result` line carries usage, not text.
///
/// One honest caveat. The error path below is captured from a real run
/// (see the tests). The success shape — `assistant.message` carrying
/// `data.content` — could not be: the account this was built against had
/// its Copilot chat quota exhausted, so no turn ever produced assistant
/// text. It is taken instead from the CLI's own bundle, where the emit
/// site reads `this.emit("assistant.message", {messageId, content})`.
/// That is the implementation rather than the docs, but it is still not
/// a capture, which is exactly why [`Provider::wants_full_output`] is on:
/// if the shape is wrong, the turn's raw output still reaches the user
/// instead of the reply vanishing with a report of success.
pub struct Copilot;

impl Provider for Copilot {
    fn id(&self) -> &'static str {
        "copilot"
    }

    fn build_command(&self, request: &TurnRequest) -> TurnCommand {
        // Scope caps first: a scoped tab never auto-approves (ADR-0014).
        let allow_all = effective_permission(request.permission, request.subtask.as_ref())
            == Permission::Bypass;
        let mut args = vec![
            "-p".to_owned(),
            effective_prompt(request, "copilot", false),
            "--output-format".to_owned(),
            "json".to_owned(),
            // Belt and braces: the JSON writer should not colour itself,
            // but an escape sequence in the stream would break every line.
            "--no-color".to_owned(),
        ];
        if allow_all {
            args.push("--allow-all-tools".to_owned());
        }
        if let Some(model) = request.model.as_deref() {
            args.push("--model".to_owned());
            args.push(model.to_owned());
        }
        if let Some(effort) = request.effort.as_deref() {
            args.push("--effort".to_owned());
            args.push(effort.to_owned());
        }
        TurnCommand { program: "copilot".to_owned(), args }
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            return Vec::new();
        };
        let Some(data) = value.get("data") else { return Vec::new() };
        match value.get("type").and_then(Value::as_str) {
            Some("assistant.message") => {
                // A tool request rides the same event with empty content;
                // emitting that would put a blank bubble in the chat.
                let text = data.get("content").and_then(Value::as_str).unwrap_or_default();
                if text.trim().is_empty() {
                    return Vec::new();
                }
                vec![AgentEvent::AssistantMessage { text: text.to_owned() }]
            }
            Some("session.error") => {
                let message = data.get("message").and_then(Value::as_str).unwrap_or_default();
                if message.trim().is_empty() {
                    return Vec::new();
                }
                vec![AgentEvent::ErrorOccurred {
                    message: message.to_owned(),
                    context: None,
                    stderr_tail: None,
                }]
            }
            _ => Vec::new(),
        }
    }

    fn wants_full_output(&self) -> bool {
        true // so a build whose stream we cannot read still gets its reply out
    }

    fn parse_final(&self, full_output: &str, emitted_message: bool) -> Vec<AgentEvent> {
        // Only reached when nothing in the stream was recognised; the raw
        // text is then the best available reading of the turn.
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

    // Captured from GitHub Copilot CLI 1.0.81
    // (`copilot -p … --output-format json`), trimmed to the fields the
    // parser reads. The quota error is the real one that run produced.
    const MCP_STATUS: &str = r#"{"type":"session.mcp_server_status_changed","data":{"serverName":"github-mcp-server","status":"connected"},"ephemeral":true,"id":"3b850361","timestamp":"2026-08-28T14:03:20.170Z"}"#;
    const TURN_START: &str = r#"{"type":"assistant.turn_start","data":{"turnId":"0","interactionId":"9e3d1b98"},"id":"80422d87","timestamp":"2026-08-28T14:03:21.511Z"}"#;
    const SESSION_ERROR: &str = r#"{"type":"session.error","data":{"errorType":"quota","message":"You have exceeded your monthly quota (Request ID: 3E69:27654)","statusCode":402,"errorCode":"quota_exceeded"},"id":"ff0e4716","timestamp":"2026-08-28T14:03:21.857Z"}"#;
    const RESULT: &str = r#"{"type":"result","timestamp":"2026-08-28T14:03:21.917Z","sessionId":"517ebbae","exitCode":1,"usage":{"premiumRequests":0,"sessionDurationMs":2933}}"#;
    // Shape from the CLI bundle's emit site, not a live capture — see the
    // caveat on [`Copilot`].
    const MESSAGE: &str =
        r#"{"type":"assistant.message","data":{"messageId":"m1","content":"All set."},"id":"a1"}"#;
    const TOOL_REQUEST: &str = r#"{"type":"assistant.message","data":{"messageId":"m2","content":"","toolRequests":[{"toolCallId":"c1","name":"bash"}]},"id":"a2"}"#;

    #[test]
    fn builds_a_json_command_with_the_prompt_behind_p() {
        let cmd = Copilot.build_command(&test_request("hi"));
        assert_eq!(cmd.program, "copilot");
        assert_eq!(cmd.args, vec!["-p", "hi", "--output-format", "json", "--no-color"]);
    }

    #[test]
    fn model_and_effort_become_flags() {
        let request = TurnRequest {
            model: Some("gpt-5-mini".to_owned()),
            effort: Some("high".to_owned()),
            ..test_request("hi")
        };
        let args = Copilot.build_command(&request).args;
        assert!(args.windows(2).any(|w| w == ["--model", "gpt-5-mini"]));
        assert!(args.windows(2).any(|w| w == ["--effort", "high"]));
    }

    #[test]
    fn only_bypass_allows_every_tool() {
        // The CLI calls --allow-all-tools "required for non-interactive
        // mode". Sending it regardless would let a Manual tab act
        // unattended, which is the one thing this path cannot undo.
        for permission in [Permission::Manual, Permission::Auto] {
            let request = TurnRequest { permission, ..test_request("go") };
            let args = Copilot.build_command(&request).args;
            assert!(!args.iter().any(|a| a == "--allow-all-tools"), "{permission:?}");
        }
        let bypass = TurnRequest { permission: Permission::Bypass, ..test_request("go") };
        assert!(Copilot
            .build_command(&bypass)
            .args
            .iter()
            .any(|a| a == "--allow-all-tools"));
    }

    #[test]
    fn a_read_only_subtask_never_allows_every_tool_and_states_the_scope() {
        let request = TurnRequest {
            permission: Permission::Bypass,
            subtask: Some(SubtaskScope::ReadOnly),
            ..test_request("look around")
        };
        let args = Copilot.build_command(&request).args;
        assert!(!args.iter().any(|a| a == "--allow-all-tools"));
        assert!(args[1].contains("READ-ONLY"));
    }

    #[test]
    fn an_assistant_message_carries_the_reply() {
        assert_eq!(
            Copilot.parse_line(MESSAGE),
            vec![AgentEvent::AssistantMessage { text: "All set.".into() }]
        );
    }

    #[test]
    fn a_session_error_becomes_an_error_rather_than_a_reply() {
        assert_eq!(
            Copilot.parse_line(SESSION_ERROR),
            vec![AgentEvent::ErrorOccurred {
                message: "You have exceeded your monthly quota (Request ID: 3E69:27654)".into(),
                context: None,
                stderr_tail: None,
            }]
        );
    }

    #[test]
    fn a_tool_request_is_not_an_empty_bubble() {
        // Same event type as a reply, with content ""; emitting it would
        // put a blank assistant message in the chat before every tool run.
        assert!(Copilot.parse_line(TOOL_REQUEST).is_empty());
    }

    #[test]
    fn bookkeeping_lines_and_junk_produce_nothing() {
        assert!(Copilot.parse_line(MCP_STATUS).is_empty());
        assert!(Copilot.parse_line(TURN_START).is_empty());
        assert!(Copilot.parse_line(RESULT).is_empty());
        assert!(Copilot.parse_line("{ not json").is_empty());
        assert!(Copilot.parse_line("").is_empty());
    }

    #[test]
    fn plain_text_output_still_yields_a_reply() {
        assert_eq!(
            Copilot.parse_final("just plain words\n", false),
            vec![AgentEvent::AssistantMessage { text: "just plain words".into() }]
        );
    }

    #[test]
    fn a_json_stream_is_never_replayed_as_raw_text() {
        let stream = format!("{MCP_STATUS}\n{MESSAGE}\n{RESULT}\n");
        assert!(Copilot.parse_final(&stream, true).is_empty());
        assert!(Copilot.parse_final(&stream, false).is_empty());
    }
}
