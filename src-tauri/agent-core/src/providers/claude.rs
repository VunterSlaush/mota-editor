use serde_json::Value;

use crate::event::AgentEvent;
use crate::provider::{summarize_tool_input, Provider, TurnCommand};
use crate::turn::{effective_prompt, external_attachment_dirs, Mode, Permission, TurnRequest};

/// Adapter for Anthropic's Claude Code CLI in headless mode:
/// `claude -p <prompt> --output-format stream-json --verbose [--resume <id>]`
///
/// Mode mapping: plan is native (`--permission-mode plan`); ask borrows
/// that same read-only tier and adds its own preamble; debug is a
/// prompt preamble. Permission bypass maps to
/// `--dangerously-skip-permissions`, auto to `--permission-mode auto` —
/// the CLI's own permission system approves safe actions and asks about
/// risky ones (both ignored in plan mode — plan never writes).
/// Attachment folders outside the project are granted via `--add-dir`.
///
/// Stream reference: newline-delimited JSON objects with a `type` field —
/// `system/init` (carries `session_id`), `assistant` (message content
/// blocks), `result` (final result + `session_id`).
pub struct Claude;

impl Provider for Claude {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn build_command(&self, request: &TurnRequest) -> TurnCommand {
        let mut args = vec![
            "-p".to_owned(),
            effective_prompt(request, true),
            "--output-format".to_owned(),
            "stream-json".to_owned(),
            "--verbose".to_owned(),
        ];
        match (request.mode, request.permission) {
            // Ask is read-only too, and plan is the only read-only
            // permission mode the CLI has — the preamble is what keeps
            // the two apart. See `turn::mode_preamble`.
            (Mode::Plan | Mode::Ask, _) => {
                args.push("--permission-mode".to_owned());
                args.push("plan".to_owned());
            }
            (_, Permission::Bypass) => args.push("--dangerously-skip-permissions".to_owned()),
            (_, Permission::Auto) => {
                args.push("--permission-mode".to_owned());
                args.push("auto".to_owned());
            }
            (_, Permission::Manual) => {}
        }
        if let Some(model) = request.model.as_deref() {
            args.push("--model".to_owned());
            args.push(model.to_owned());
        }
        if let Some(effort) = request.effort.as_deref() {
            args.push("--effort".to_owned());
            args.push(effort.to_owned());
        }
        for dir in external_attachment_dirs(request) {
            args.push("--add-dir".to_owned());
            args.push(dir);
        }
        if let Some(id) = request.resume_session_id.as_deref() {
            args.push("--resume".to_owned());
            args.push(id.to_owned());
        }
        TurnCommand { program: "claude".to_owned(), args }
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        match value.get("type").and_then(Value::as_str) {
            Some("system") => parse_system(&value),
            Some("assistant") => parse_assistant(&value),
            Some("result") => parse_result(&value),
            _ => Vec::new(),
        }
    }
}

fn parse_system(value: &Value) -> Vec<AgentEvent> {
    let is_init = value.get("subtype").and_then(Value::as_str) == Some("init");
    match (is_init, value.get("session_id").and_then(Value::as_str)) {
        (true, Some(id)) => vec![AgentEvent::SessionStarted {
            provider_session_id: id.to_owned(),
        }],
        _ => Vec::new(),
    }
}

fn parse_assistant(value: &Value) -> Vec<AgentEvent> {
    let Some(content) = value
        .pointer("/message/content")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    content.iter().filter_map(parse_content_block).collect()
}

fn parse_content_block(block: &Value) -> Option<AgentEvent> {
    match block.get("type").and_then(Value::as_str)? {
        "text" => {
            let text = block.get("text").and_then(Value::as_str)?.trim();
            (!text.is_empty()).then(|| AgentEvent::AssistantMessage { text: text.to_owned() })
        }
        "tool_use" => Some(AgentEvent::ToolUse {
            name: block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_owned(),
            detail: block
                .get("input")
                .map(summarize_tool_input)
                .unwrap_or_default(),
        }),
        _ => None,
    }
}

fn parse_result(value: &Value) -> Vec<AgentEvent> {
    vec![AgentEvent::TurnCompleted {
        result: value.get("result").and_then(Value::as_str).map(str::to_owned),
        provider_session_id: value
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        is_error: value.get("is_error").and_then(Value::as_bool).unwrap_or(false),
        stop_reason: None,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::turn::test_request;

    #[test]
    fn builds_headless_command_with_resume() {
        let request = TurnRequest {
            resume_session_id: Some("abc".to_owned()),
            ..test_request("fix the bug")
        };
        let cmd = Claude.build_command(&request);
        assert_eq!(cmd.program, "claude");
        assert_eq!(
            cmd.args,
            vec!["-p", "fix the bug", "--output-format", "stream-json", "--verbose", "--resume", "abc"]
        );
    }

    #[test]
    fn plan_mode_uses_the_native_flag_and_wins_over_bypass() {
        let request = TurnRequest {
            mode: Mode::Plan,
            permission: Permission::Bypass,
            ..test_request("plan it")
        };
        let args = Claude.build_command(&request).args;
        assert!(args.contains(&"--permission-mode".to_owned()));
        assert!(args.contains(&"plan".to_owned()));
        assert!(!args.contains(&"--dangerously-skip-permissions".to_owned()));
        assert_eq!(args[1], "plan it"); // no preamble: plan is native
    }

    #[test]
    fn ask_mode_is_read_only_too_and_still_carries_its_preamble() {
        let request = TurnRequest {
            mode: Mode::Ask,
            permission: Permission::Bypass,
            ..test_request("where is auth handled?")
        };
        let args = Claude.build_command(&request).args;
        assert!(args.contains(&"--permission-mode".to_owned()));
        assert!(args.contains(&"plan".to_owned()));
        assert!(!args.contains(&"--dangerously-skip-permissions".to_owned()));
        // Unlike plan, the preamble stays: the flag is plan's, and only
        // the wording tells the agent to answer instead of planning.
        assert!(args[1].starts_with("You are in ASK MODE."));
    }

    #[test]
    fn bypass_permission_adds_the_skip_flag() {
        let request = TurnRequest { permission: Permission::Bypass, ..test_request("go") };
        assert!(Claude
            .build_command(&request)
            .args
            .contains(&"--dangerously-skip-permissions".to_owned()));
    }

    #[test]
    fn auto_permission_maps_to_the_native_auto_mode() {
        let request = TurnRequest { permission: Permission::Auto, ..test_request("go") };
        let args = Claude.build_command(&request).args;
        assert!(args.contains(&"--permission-mode".to_owned()));
        assert!(args.contains(&"auto".to_owned()));
        assert!(!args.contains(&"--dangerously-skip-permissions".to_owned()));
    }

    #[test]
    fn plan_mode_wins_over_auto_permission() {
        let request = TurnRequest {
            mode: Mode::Plan,
            permission: Permission::Auto,
            ..test_request("plan it")
        };
        let args = Claude.build_command(&request).args;
        assert!(args.contains(&"plan".to_owned()));
        assert!(!args.contains(&"auto".to_owned()));
    }

    #[test]
    fn external_attachment_folders_are_added_with_add_dir() {
        let request = TurnRequest {
            attachments: vec!["/docs/spec.pdf".to_owned()],
            ..test_request("read the spec")
        };
        let args = Claude.build_command(&request).args;
        assert!(args.contains(&"--add-dir".to_owned()));
        assert!(args.contains(&"/docs".to_owned()));
        assert!(args[1].contains("- /docs/spec.pdf"));
    }

    #[test]
    fn init_line_yields_session_started() {
        let events = Claude
            .parse_line(r#"{"type":"system","subtype":"init","session_id":"s1","tools":[]}"#);
        assert_eq!(
            events,
            vec![AgentEvent::SessionStarted { provider_session_id: "s1".into() }]
        );
    }

    #[test]
    fn assistant_line_yields_text_and_tool_use() {
        let line = r#"{"type":"assistant","message":{"content":[
            {"type":"text","text":"Running tests."},
            {"type":"tool_use","name":"Bash","input":{"command":"npm test"}}
        ]},"session_id":"s1"}"#
            .replace('\n', "");
        let events = Claude.parse_line(&line);
        assert_eq!(
            events,
            vec![
                AgentEvent::AssistantMessage { text: "Running tests.".into() },
                AgentEvent::ToolUse { name: "Bash".into(), detail: "npm test".into() },
            ]
        );
    }

    #[test]
    fn result_line_completes_the_turn() {
        let events = Claude.parse_line(
            r#"{"type":"result","subtype":"success","result":"All green.","session_id":"s1","is_error":false}"#,
        );
        assert_eq!(
            events,
            vec![AgentEvent::TurnCompleted {
                result: Some("All green.".into()),
                provider_session_id: Some("s1".into()),
                is_error: false,
                stop_reason: None,
            }]
        );
    }

    #[test]
    fn garbage_lines_are_ignored() {
        assert!(Claude.parse_line("not json").is_empty());
        assert!(Claude.parse_line(r#"{"type":"unknown"}"#).is_empty());
    }
}
