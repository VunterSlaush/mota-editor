use serde_json::Value;

use crate::event::AgentEvent;
use crate::provider::{summarize_tool_input, Provider, TurnCommand};
use crate::scope::effective_permission;
use crate::turn::{effective_prompt, Permission, TurnRequest};

/// Adapter for the OpenCode CLI in headless mode:
/// `opencode run --format json [-m <model>] [--variant <effort>] <prompt>`
///
/// This is the FALLBACK path. OpenCode speaks ACP from the same binary
/// (`opencode acp`), so this only runs when the installed version cannot
/// complete the ACP handshake — in practice, an outdated install.
///
/// Mode and scope are prompt preambles: opencode's headless run exposes
/// no read-only tier. Permission bypass maps to `--auto`, which the CLI
/// itself labels dangerous; manual and auto add no flag, leaving
/// opencode's own approval behaviour in place.
///
/// The stream is one JSON object per line (`step_start`, `text`,
/// `tool_use`, `step_finish`), so everything parses in
/// [`Provider::parse_line`]. `parse_final` exists only to recover a reply
/// from a build whose output was not JSON at all.
pub struct Opencode;

impl Provider for Opencode {
    fn id(&self) -> &'static str {
        "opencode"
    }

    fn build_command(&self, request: &TurnRequest) -> TurnCommand {
        let mut args = vec!["run".to_owned(), "--format".to_owned(), "json".to_owned()];
        if let Some(session) = request.resume_session_id.as_deref() {
            args.push("--session".to_owned());
            args.push(session.to_owned());
        }
        if let Some(model) = request.model.as_deref() {
            args.push("--model".to_owned());
            args.push(model.to_owned());
        }
        if let Some(effort) = request.effort.as_deref() {
            args.push("--variant".to_owned());
            args.push(effort.to_owned());
        }
        // Scope caps first: a scoped tab never gets `--auto` (ADR-0014).
        if effective_permission(request.permission, request.subtask.as_ref())
            == Permission::Bypass
        {
            args.push("--auto".to_owned());
        }
        // Prompt last: it is a positional, and anything after it would be
        // read as more of the message.
        args.push(effective_prompt(request, "opencode", false));
        TurnCommand { program: "opencode".to_owned(), args }
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            return Vec::new();
        };
        let part = value.get("part");
        match value.get("type").and_then(Value::as_str).unwrap_or_default() {
            "step_start" => value
                .get("sessionID")
                .and_then(Value::as_str)
                .map(|id| {
                    vec![AgentEvent::SessionStarted { provider_session_id: id.to_owned() }]
                })
                .unwrap_or_default(),
            "text" => part
                .and_then(|p| p.get("text"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(|text| vec![AgentEvent::AssistantMessage { text: text.to_owned() }])
                .unwrap_or_default(),
            "tool_use" => {
                let Some(part) = part else { return Vec::new() };
                let name = part
                    .get("tool")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_owned();
                // The tool's own title is already a one-line summary; fall
                // back to the shared input summariser when it has none.
                let detail = part
                    .pointer("/state/title")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| part.pointer("/state/input").map(summarize_tool_input))
                    .unwrap_or_default();
                vec![AgentEvent::ToolUse { name, detail }]
            }
            _ => Vec::new(),
        }
    }

    fn wants_full_output(&self) -> bool {
        true // so a non-JSON build still gets its reply read
    }

    fn parse_final(&self, full_output: &str, emitted_message: bool) -> Vec<AgentEvent> {
        super::plain_text_reply(full_output, emitted_message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::scope::SubtaskScope;
    use crate::turn::test_request;

    // Captured from opencode 1.18.19 (`opencode run --format json`).
    const STEP_START: &str = r#"{"type":"step_start","timestamp":1787250052198,"sessionID":"ses_fdf988fb8ffeNse7NYkTVQL1tj","part":{"id":"prt_020678c60001kX81l2PfTnB1zp","messageID":"msg_020677615001tr7BG4dlZt2MuN","sessionID":"ses_fdf988fb8ffeNse7NYkTVQL1tj","type":"step-start"}}"#;
    const TEXT: &str = r#"{"type":"text","timestamp":1787250052499,"sessionID":"ses_fdf988fb8ffeNse7NYkTVQL1tj","part":{"id":"prt_020678d7d0014b3Eu2wQwxAcZv","messageID":"msg_020677615001tr7BG4dlZt2MuN","sessionID":"ses_fdf988fb8ffeNse7NYkTVQL1tj","type":"text","text":"pong","time":{"start":1787250052477,"end":1787250052484}}}"#;
    const TOOL_USE: &str = r#"{"type":"tool_use","timestamp":1787250073547,"sessionID":"ses_fdf9842e2ffeyusMzNvjaydr16","part":{"type":"tool","tool":"bash","callID":"call_9c971cf691fc4f0bbfd3d816","state":{"status":"completed","input":{"command":"echo hello"},"output":"hello\n","metadata":{"output":"hello\n","exit":0,"truncated":false},"title":"echo hello","time":{"start":1787250073516,"end":1787250073529}},"id":"prt_02067de63001V9uEaNrcHDwIU6","sessionID":"ses_fdf9842e2ffeyusMzNvjaydr16","messageID":"msg_02067bf16001HD9eqYVcF3Kp2d"}}"#;
    const STEP_FINISH: &str = r#"{"type":"step_finish","timestamp":1787250053496,"sessionID":"ses_fdf988fb8ffeNse7NYkTVQL1tj","part":{"id":"prt_020679135001bb99TeeWY80rYL","reason":"stop","type":"step-finish","tokens":{"total":9294,"input":62,"output":16,"reasoning":0,"cache":{"write":0,"read":9216}},"cost":0}}"#;

    #[test]
    fn builds_a_json_run_command_with_the_prompt_last() {
        let cmd = Opencode.build_command(&test_request("hi"));
        assert_eq!(cmd.program, "opencode");
        assert_eq!(cmd.args, vec!["run", "--format", "json", "hi"]);
    }

    #[test]
    fn a_known_session_is_continued_rather_than_restarted() {
        let request = TurnRequest {
            resume_session_id: Some("ses_abc".to_owned()),
            ..test_request("and then?")
        };
        let args = Opencode.build_command(&request).args;
        assert!(args.windows(2).any(|w| w == ["--session", "ses_abc"]));
    }

    #[test]
    fn model_and_effort_become_flags() {
        let request = TurnRequest {
            model: Some("opencode/big-pickle".to_owned()),
            effort: Some("high".to_owned()),
            ..test_request("hi")
        };
        let args = Opencode.build_command(&request).args;
        assert!(args.windows(2).any(|w| w == ["--model", "opencode/big-pickle"]));
        assert!(args.windows(2).any(|w| w == ["--variant", "high"]));
        assert_eq!(args.last().unwrap(), "hi");
    }

    #[test]
    fn only_bypass_hands_over_auto_approval() {
        for (permission, expected) in [
            (Permission::Manual, false),
            (Permission::Auto, false),
            (Permission::Bypass, true),
        ] {
            let request = TurnRequest { permission, ..test_request("go") };
            let args = Opencode.build_command(&request).args;
            assert_eq!(args.contains(&"--auto".to_owned()), expected, "{permission:?}");
        }
    }

    #[test]
    fn a_read_only_subtask_never_gets_auto_and_states_the_scope() {
        let request = TurnRequest {
            permission: Permission::Bypass,
            subtask: Some(SubtaskScope::ReadOnly),
            ..test_request("look around")
        };
        let args = Opencode.build_command(&request).args;
        assert!(!args.contains(&"--auto".to_owned()));
        assert!(args.last().unwrap().contains("READ-ONLY"));
    }

    #[test]
    fn a_step_start_reports_the_session_it_opened() {
        assert_eq!(
            Opencode.parse_line(STEP_START),
            vec![AgentEvent::SessionStarted {
                provider_session_id: "ses_fdf988fb8ffeNse7NYkTVQL1tj".into()
            }]
        );
    }

    #[test]
    fn a_text_part_becomes_the_assistant_message() {
        assert_eq!(
            Opencode.parse_line(TEXT),
            vec![AgentEvent::AssistantMessage { text: "pong".into() }]
        );
    }

    #[test]
    fn a_tool_use_is_summarised_by_its_own_title() {
        assert_eq!(
            Opencode.parse_line(TOOL_USE),
            vec![AgentEvent::ToolUse { name: "bash".into(), detail: "echo hello".into() }]
        );
    }

    #[test]
    fn bookkeeping_lines_and_junk_produce_nothing() {
        // step_finish carries only totals the runner already reports, and
        // a partial line must never be mistaken for content.
        assert!(Opencode.parse_line(STEP_FINISH).is_empty());
        assert!(Opencode.parse_line("{ not json").is_empty());
        assert!(Opencode.parse_line("").is_empty());
    }

    #[test]
    fn plain_text_output_still_yields_a_reply() {
        // A build that ignores --format json must not be silently mute.
        assert_eq!(
            Opencode.parse_final("just plain words\n", false),
            vec![AgentEvent::AssistantMessage { text: "just plain words".into() }]
        );
    }

    #[test]
    fn nothing_extra_when_a_message_was_already_emitted() {
        assert!(Opencode.parse_final("pong", true).is_empty());
    }
}
