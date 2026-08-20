use serde_json::Value;

use crate::event::AgentEvent;
use crate::provider::{truncate, Provider, TurnCommand};
use crate::scope::{effective_permission, SubtaskScope};
use crate::turn::{effective_prompt, Mode, Permission, TurnRequest};

/// Adapter for OpenAI's Codex CLI (ChatGPT) in headless mode:
/// `codex exec --json [resume <id>] <prompt>`
///
/// Mode mapping: plan is the preamble PLUS a mechanically enforced
/// `--sandbox read-only` (and wins over bypass — a plan never writes);
/// ask takes the same sandbox with its own preamble; debug is a
/// preamble. Permission bypass maps to
/// `--dangerously-bypass-approvals-and-sandbox`, auto to `--full-auto`
/// (workspace-write sandbox); manual keeps codex's default sandbox.
///
/// Stream reference: newline-delimited JSON. Current format uses
/// `thread.started` / `item.completed` / `turn.completed`; older builds
/// used `{"msg":{"type":"agent_message",...}}`. Both are handled, and
/// unknown lines are ignored so CLI drift degrades gracefully.
pub struct Codex;

impl Provider for Codex {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn build_command(&self, request: &TurnRequest) -> TurnCommand {
        let mut args = vec!["exec".to_owned()];
        if let Some(id) = request.resume_session_id.as_deref() {
            args.push("resume".to_owned());
            args.push(id.to_owned());
        }
        args.push("--json".to_owned());
        args.push("--skip-git-repo-check".to_owned());
        if let Some(model) = request.model.as_deref() {
            args.push("--model".to_owned());
            args.push(model.to_owned());
        }
        // The effort lands inside a TOML string literal; anything beyond
        // a plain identifier could close the quote and append arbitrary
        // config overrides (e.g. relaxing the sandbox), so drop it.
        if let Some(effort) = request.effort.as_deref() {
            if effort.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                args.push("-c".to_owned());
                args.push(format!("model_reasoning_effort=\"{effort}\""));
            }
        }
        // A read-only subtask gets plan mode's sandbox without plan
        // mode's behavior; a boundary subtask has its bypass capped
        // (`effective_permission`), so the workspace sandbox stays up.
        // Ask is read-only too — same sandbox, different preamble.
        let read_only_scope = matches!(request.subtask, Some(SubtaskScope::ReadOnly));
        if matches!(request.mode, Mode::Plan | Mode::Ask) || read_only_scope {
            args.push("--sandbox".to_owned());
            args.push("read-only".to_owned());
        } else {
            match effective_permission(request.permission, request.subtask.as_ref()) {
                Permission::Bypass => {
                    args.push("--dangerously-bypass-approvals-and-sandbox".to_owned());
                }
                Permission::Auto => {
                    // Codex's accept-edits tier: writes stay inside the
                    // workspace, the sandbox still guards everything else.
                    args.push("--full-auto".to_owned());
                }
                Permission::Manual => {}
            }
        }
        args.push(effective_prompt(request, false));
        TurnCommand { program: "codex".to_owned(), args }
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        if let Some(kind) = value.get("type").and_then(Value::as_str) {
            return parse_typed(kind, &value);
        }
        parse_legacy(&value)
    }
}

fn parse_typed(kind: &str, value: &Value) -> Vec<AgentEvent> {
    match kind {
        "thread.started" | "session.created" => session_started(value),
        "item.completed" => value.get("item").map(parse_item).unwrap_or_default(),
        "turn.completed" => vec![AgentEvent::TurnCompleted {
            result: None,
            provider_session_id: None,
            is_error: false,
            stop_reason: None,
        }],
        "turn.failed" => {
            let message = value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("The turn failed.")
                .to_owned();
            vec![
                AgentEvent::ErrorOccurred { message, context: None, stderr_tail: None },
                AgentEvent::TurnCompleted {
                    result: None,
                    provider_session_id: None,
                    is_error: true,
                    stop_reason: None,
                },
            ]
        }
        "error" => vec![AgentEvent::ErrorOccurred {
            message: value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Unknown error.")
                .to_owned(),
            context: None,
            stderr_tail: None,
        }],
        _ => Vec::new(),
    }
}

fn session_started(value: &Value) -> Vec<AgentEvent> {
    ["thread_id", "session_id"]
        .iter()
        .find_map(|k| value.get(*k).and_then(Value::as_str))
        .map(|id| {
            vec![AgentEvent::SessionStarted { provider_session_id: id.to_owned() }]
        })
        .unwrap_or_default()
}

fn parse_item(item: &Value) -> Vec<AgentEvent> {
    let item_type = item
        .get("item_type")
        .or_else(|| item.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    match item_type {
        "agent_message" | "assistant_message" => item
            .get("text")
            .and_then(Value::as_str)
            .filter(|t| !t.trim().is_empty())
            .map(|t| vec![AgentEvent::AssistantMessage { text: t.trim().to_owned() }])
            .unwrap_or_default(),
        "command_execution" => vec![AgentEvent::ToolUse {
            name: "shell".to_owned(),
            detail: truncate(
                item.get("command").and_then(Value::as_str).unwrap_or_default(),
                200,
            ),
        }],
        "file_change" | "patch_apply" => vec![AgentEvent::ToolUse {
            name: "edit".to_owned(),
            detail: truncate(&item.to_string(), 200),
        }],
        _ => Vec::new(),
    }
}

/// Older codex builds: `{"id":"...","msg":{"type":"agent_message","message":"..."}}`
fn parse_legacy(value: &Value) -> Vec<AgentEvent> {
    let Some(msg) = value.get("msg") else {
        return Vec::new();
    };
    match msg.get("type").and_then(Value::as_str) {
        Some("agent_message") => msg
            .get("message")
            .and_then(Value::as_str)
            .map(|t| vec![AgentEvent::AssistantMessage { text: t.trim().to_owned() }])
            .unwrap_or_default(),
        Some("session_configured") => msg
            .get("session_id")
            .and_then(Value::as_str)
            .map(|id| {
                vec![AgentEvent::SessionStarted { provider_session_id: id.to_owned() }]
            })
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::turn::test_request;

    #[test]
    fn builds_exec_command_and_resume_variant() {
        let fresh = Codex.build_command(&test_request("hello"));
        assert_eq!(fresh.args, vec!["exec", "--json", "--skip-git-repo-check", "hello"]);

        let resumed = Codex.build_command(&TurnRequest {
            resume_session_id: Some("t1".to_owned()),
            ..test_request("more")
        });
        assert_eq!(
            resumed.args,
            vec!["exec", "resume", "t1", "--json", "--skip-git-repo-check", "more"]
        );
    }

    #[test]
    fn ask_mode_takes_the_read_only_sandbox_over_bypass() {
        let request = TurnRequest {
            mode: Mode::Ask,
            permission: Permission::Bypass,
            ..test_request("what does the runner do?")
        };
        let args = Codex.build_command(&request).args;
        assert!(args.contains(&"--sandbox".to_owned()));
        assert!(args.contains(&"read-only".to_owned()));
        assert!(!args.contains(&"--dangerously-bypass-approvals-and-sandbox".to_owned()));
        assert!(args.last().unwrap().starts_with("You are in ASK MODE."));
    }

    #[test]
    fn bypass_permission_adds_the_bypass_flag() {
        let request = TurnRequest { permission: Permission::Bypass, ..test_request("go") };
        assert!(Codex
            .build_command(&request)
            .args
            .contains(&"--dangerously-bypass-approvals-and-sandbox".to_owned()));
    }

    #[test]
    fn auto_permission_adds_full_auto() {
        let request = TurnRequest { permission: Permission::Auto, ..test_request("go") };
        let args = Codex.build_command(&request).args;
        assert!(args.contains(&"--full-auto".to_owned()));
        assert!(!args.contains(&"--dangerously-bypass-approvals-and-sandbox".to_owned()));
    }

    #[test]
    fn plan_mode_stays_read_only_over_auto() {
        let request = TurnRequest {
            mode: Mode::Plan,
            permission: Permission::Auto,
            ..test_request("plan it")
        };
        let args = Codex.build_command(&request).args;
        assert!(args.contains(&"read-only".to_owned()));
        assert!(!args.contains(&"--full-auto".to_owned()));
    }

    #[test]
    fn plan_mode_becomes_a_prompt_preamble() {
        let request = TurnRequest { mode: Mode::Plan, ..test_request("add auth") };
        let prompt = Codex.build_command(&request).args.last().unwrap().clone();
        assert!(prompt.starts_with("You are in PLAN MODE."));
        assert!(prompt.ends_with("add auth"));
    }

    #[test]
    fn plan_mode_is_mechanically_read_only_and_wins_over_bypass() {
        let request = TurnRequest {
            mode: Mode::Plan,
            permission: Permission::Bypass,
            ..test_request("plan it")
        };
        let args = Codex.build_command(&request).args;
        assert!(args.contains(&"--sandbox".to_owned()));
        assert!(args.contains(&"read-only".to_owned()));
        assert!(!args.contains(&"--dangerously-bypass-approvals-and-sandbox".to_owned()));
    }

    #[test]
    fn a_read_only_subtask_is_sandboxed_read_only_even_over_bypass() {
        let request = TurnRequest {
            permission: Permission::Bypass,
            subtask: Some(SubtaskScope::ReadOnly),
            ..test_request("look around")
        };
        let args = Codex.build_command(&request).args;
        assert!(args.contains(&"--sandbox".to_owned()));
        assert!(args.contains(&"read-only".to_owned()));
        assert!(!args.contains(&"--dangerously-bypass-approvals-and-sandbox".to_owned()));
        assert!(!args.contains(&"--full-auto".to_owned()));
    }

    #[test]
    fn a_boundary_subtask_caps_bypass_to_the_workspace_sandbox() {
        let request = TurnRequest {
            permission: Permission::Bypass,
            subtask: Some(SubtaskScope::Boundary { boundaries: vec!["apps/web".to_owned()] }),
            ..test_request("edit the web app")
        };
        let args = Codex.build_command(&request).args;
        assert!(args.contains(&"--full-auto".to_owned()));
        assert!(!args.contains(&"--dangerously-bypass-approvals-and-sandbox".to_owned()));
        assert!(!args.contains(&"read-only".to_owned()));
    }

    #[test]
    fn thread_started_yields_session() {
        let events = Codex.parse_line(r#"{"type":"thread.started","thread_id":"t9"}"#);
        assert_eq!(
            events,
            vec![AgentEvent::SessionStarted { provider_session_id: "t9".into() }]
        );
    }

    #[test]
    fn completed_agent_message_item_yields_assistant_message() {
        let events = Codex.parse_line(
            r#"{"type":"item.completed","item":{"item_type":"agent_message","text":"Done."}}"#,
        );
        assert_eq!(events, vec![AgentEvent::AssistantMessage { text: "Done.".into() }]);
    }

    #[test]
    fn command_execution_item_yields_tool_use() {
        let events = Codex.parse_line(
            r#"{"type":"item.completed","item":{"item_type":"command_execution","command":"cargo test"}}"#,
        );
        assert_eq!(
            events,
            vec![AgentEvent::ToolUse { name: "shell".into(), detail: "cargo test".into() }]
        );
    }

    #[test]
    fn turn_completed_and_failed_map_to_completion() {
        assert_eq!(
            Codex.parse_line(r#"{"type":"turn.completed","usage":{}}"#),
            vec![AgentEvent::TurnCompleted {
                result: None,
                provider_session_id: None,
                is_error: false,
                stop_reason: None
            }]
        );
        let failed = Codex.parse_line(r#"{"type":"turn.failed","error":{"message":"boom"}}"#);
        assert_eq!(failed.len(), 2);
        assert_eq!(
            failed[0],
            AgentEvent::ErrorOccurred {
                message: "boom".into(),
                context: None,
                stderr_tail: None
            }
        );
    }

    #[test]
    fn legacy_msg_format_still_parses() {
        let events = Codex.parse_line(r#"{"id":"0","msg":{"type":"agent_message","message":"Hi"}}"#);
        assert_eq!(events, vec![AgentEvent::AssistantMessage { text: "Hi".into() }]);
    }
}
