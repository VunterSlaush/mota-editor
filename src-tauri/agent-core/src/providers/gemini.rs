use serde_json::Value;

use crate::event::AgentEvent;
use crate::provider::{Provider, TurnCommand};
use crate::turn::{effective_prompt, external_attachment_dirs, Permission, TurnRequest};

/// Adapter for Google's Gemini CLI in headless mode:
/// `gemini -p <prompt> --output-format json`
///
/// Mode mapping: plan and debug are prompt preambles. Permission bypass
/// maps to `--yolo`; manual keeps gemini's default approvals. Attachment
/// folders outside the project are granted via `--include-directories`.
///
/// The JSON output (`{"response": "...", "stats": ...}`) may span multiple
/// lines, so most parsing happens in [`Provider::parse_final`] over the
/// full captured stdout. Session resume is not offered by the CLI's
/// non-interactive mode, so `supportsResume` is false on the frontend and
/// no completion event carries a session id.
pub struct Gemini;

impl Provider for Gemini {
    fn id(&self) -> &'static str {
        "gemini"
    }

    fn build_command(&self, request: &TurnRequest) -> TurnCommand {
        let mut args = vec![
            "-p".to_owned(),
            effective_prompt(request, false),
            "--output-format".to_owned(),
            "json".to_owned(),
        ];
        if let Some(model) = request.model.as_deref() {
            args.push("--model".to_owned());
            args.push(model.to_owned());
        }
        if request.permission == Permission::Bypass {
            args.push("--yolo".to_owned());
        }
        let external_dirs = external_attachment_dirs(request);
        if !external_dirs.is_empty() {
            args.push("--include-directories".to_owned());
            args.push(external_dirs.join(","));
        }
        TurnCommand { program: "gemini".to_owned(), args }
    }

    fn parse_line(&self, line: &str) -> Vec<AgentEvent> {
        // Fast path: the whole payload arrived on a single line.
        parse_json_payload(line).unwrap_or_default()
    }

    fn wants_full_output(&self) -> bool {
        true // the JSON payload may span lines; parse_final needs it all
    }

    fn parse_final(&self, full_output: &str, emitted_message: bool) -> Vec<AgentEvent> {
        if emitted_message {
            return Vec::new();
        }
        if let Some(events) = parse_json_payload(full_output) {
            return events;
        }
        // Fallback: older CLIs print plain text.
        let text = full_output.trim();
        if text.is_empty() {
            Vec::new()
        } else {
            vec![AgentEvent::AssistantMessage { text: text.to_owned() }]
        }
    }
}

fn parse_json_payload(raw: &str) -> Option<Vec<AgentEvent>> {
    let value = serde_json::from_str::<Value>(raw.trim()).ok()?;
    if let Some(response) = value.get("response").and_then(Value::as_str) {
        let text = response.trim();
        return Some(if text.is_empty() {
            Vec::new()
        } else {
            vec![AgentEvent::AssistantMessage { text: text.to_owned() }]
        });
    }
    if let Some(message) = value.pointer("/error/message").and_then(Value::as_str) {
        return Some(vec![AgentEvent::ErrorOccurred { message: message.to_owned() }]);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::turn::test_request;

    #[test]
    fn builds_json_output_command() {
        let cmd = Gemini.build_command(&test_request("hi"));
        assert_eq!(cmd.program, "gemini");
        assert_eq!(cmd.args, vec!["-p", "hi", "--output-format", "json"]);
    }

    #[test]
    fn bypass_permission_adds_yolo() {
        let request = TurnRequest { permission: Permission::Bypass, ..test_request("go") };
        assert!(Gemini.build_command(&request).args.contains(&"--yolo".to_owned()));
    }

    #[test]
    fn external_attachment_folders_use_include_directories() {
        let request = TurnRequest {
            attachments: vec!["/docs/spec.pdf".to_owned()],
            ..test_request("read it")
        };
        let args = Gemini.build_command(&request).args;
        assert!(args.contains(&"--include-directories".to_owned()));
        assert!(args.contains(&"/docs".to_owned()));
    }

    #[test]
    fn single_line_json_response_parses_immediately() {
        let events = Gemini.parse_line(r#"{"response":"Hello!","stats":{}}"#);
        assert_eq!(events, vec![AgentEvent::AssistantMessage { text: "Hello!".into() }]);
    }

    #[test]
    fn multiline_json_is_recovered_in_parse_final() {
        let full = "{\n  \"response\": \"Answer here\",\n  \"stats\": {}\n}";
        assert!(Gemini.parse_line("{").is_empty());
        let events = Gemini.parse_final(full, false);
        assert_eq!(events, vec![AgentEvent::AssistantMessage { text: "Answer here".into() }]);
    }

    #[test]
    fn plain_text_output_falls_back_to_assistant_message() {
        let events = Gemini.parse_final("just plain words\n", false);
        assert_eq!(
            events,
            vec![AgentEvent::AssistantMessage { text: "just plain words".into() }]
        );
    }

    #[test]
    fn error_payload_maps_to_error_event() {
        let events = Gemini.parse_final(r#"{"error":{"message":"quota"}}"#, false);
        assert_eq!(events, vec![AgentEvent::ErrorOccurred { message: "quota".into() }]);
    }

    #[test]
    fn nothing_extra_when_a_message_was_already_emitted() {
        assert!(Gemini.parse_final(r#"{"response":"x"}"#, true).is_empty());
    }
}
