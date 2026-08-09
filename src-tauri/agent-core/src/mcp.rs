//! MCP handshake — just enough of the protocol to ask a server what
//! tools it offers, and what carrying them costs.
//!
//! Why this exists: every enabled server's tool schemas sit in the cached
//! prefix of EVERY request for a whole session, so an unused server is a
//! fixed tax on all of it. ACP cannot report this — `session/new` takes
//! the server list and returns nothing about it, and no ACP notification
//! carries tools — so the only way to see the number is to ask the server
//! directly, the same way the agent does.
//!
//! Scope, stated plainly: this measures the servers MOTA launches. The
//! agent also loads servers from its own CLI config, which Mota cannot
//! see; a total here is a floor, not the whole prefix.
//!
//! Pure protocol only — spawning the process is `mcp_probe.rs`'s job.

use serde::Serialize;
use serde_json::{json, Value};

/// Protocol version this client speaks. Servers that require a newer one
/// still answer `tools/list`; the field is a negotiation hint, not a gate.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// What a server's tools cost to carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInventory {
    pub tool_count: u32,
    /// Estimated tokens the tool definitions add to every request.
    pub prefix_tokens: u32,
}

/// Characters per token — the same rough divisor the frontend uses for
/// its own estimates (`src/core/entities/tokens.ts`). Tool schemas are
/// dense JSON, so this is approximate by nature and labelled "~".
const CHARS_PER_TOKEN: usize = 4;

pub fn initialize_request(id: i64) -> String {
    line(&json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "mota-editor", "version": "0.1.0" },
        },
    }))
}

/// Servers may refuse `tools/list` until told the handshake finished.
pub fn initialized_notification() -> String {
    line(&json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized",
    }))
}

pub fn tools_list_request(id: i64) -> String {
    line(&json!({ "jsonrpc": "2.0", "id": id, "method": "tools/list" }))
}

/// The inventory in a `tools/list` result, or `None` when the message is
/// not one (a notification, a log line, an error response).
///
/// Counts the WHOLE definition — name, description, and input schema —
/// because all of it is what gets sent, not just the names.
pub fn parse_tools_list(message: &Value) -> Option<ToolInventory> {
    let tools = message.get("result")?.get("tools")?.as_array()?;
    let chars: usize = tools.iter().map(|tool| tool.to_string().len()).sum();
    Some(ToolInventory {
        tool_count: tools.len() as u32,
        prefix_tokens: (chars / CHARS_PER_TOKEN) as u32,
    })
}

/// Whether a parsed message is the response to `id` (rather than one of
/// the notifications and log lines servers interleave freely).
pub fn is_response_to(message: &Value, id: i64) -> bool {
    message.get("id").and_then(Value::as_i64) == Some(id)
}

fn line(value: &Value) -> String {
    format!("{value}\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(raw: &str) -> Value {
        serde_json::from_str(raw).expect("valid json")
    }

    #[test]
    fn requests_are_newline_delimited_json_rpc() {
        let request = initialize_request(1);
        assert!(request.ends_with('\n'), "servers read line by line");
        let value = parsed(request.trim());
        assert_eq!(value["method"], "initialize");
        assert_eq!(value["id"], 1);
        assert_eq!(value["jsonrpc"], "2.0");
    }

    #[test]
    fn the_initialized_notification_carries_no_id() {
        // An id would make it a request, and servers must not answer it.
        let value = parsed(initialized_notification().trim());
        assert_eq!(value["method"], "notifications/initialized");
        assert!(value.get("id").is_none());
    }

    #[test]
    fn counts_tools_and_the_tokens_they_add_to_every_request() {
        let message = parsed(
            r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[
                {"name":"read_file","description":"Read a file","inputSchema":{"type":"object"}},
                {"name":"write_file","description":"Write a file","inputSchema":{"type":"object"}}
            ]}}"#,
        );
        let inventory = parse_tools_list(&message).expect("a tools/list result");
        assert_eq!(inventory.tool_count, 2);
        assert!(inventory.prefix_tokens > 0);
    }

    #[test]
    fn counts_the_whole_definition_not_just_the_name() {
        // The schema is the bulk of what gets sent, so a tool with a big
        // schema must cost more than a bare one.
        let bare = parsed(r#"{"result":{"tools":[{"name":"a"}]}}"#);
        let rich = parsed(
            r#"{"result":{"tools":[{"name":"a","description":"a long description here",
                "inputSchema":{"type":"object","properties":{"path":{"type":"string"}}}}]}}"#,
        );
        let bare = parse_tools_list(&bare).expect("result");
        let rich = parse_tools_list(&rich).expect("result");
        assert_eq!(bare.tool_count, rich.tool_count);
        assert!(rich.prefix_tokens > bare.prefix_tokens);
    }

    #[test]
    fn a_server_with_no_tools_costs_nothing() {
        let message = parsed(r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}"#);
        assert_eq!(
            parse_tools_list(&message),
            Some(ToolInventory { tool_count: 0, prefix_tokens: 0 })
        );
    }

    #[test]
    fn ignores_everything_that_is_not_a_tools_list_result() {
        for raw in [
            r#"{"jsonrpc":"2.0","method":"notifications/message","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"no"}}"#,
            r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18"}}"#,
            r#"{"result":{"tools":"not an array"}}"#,
        ] {
            assert!(parse_tools_list(&parsed(raw)).is_none(), "{raw}");
        }
    }

    #[test]
    fn matches_a_response_to_its_request() {
        let message = parsed(r#"{"jsonrpc":"2.0","id":7,"result":{}}"#);
        assert!(is_response_to(&message, 7));
        assert!(!is_response_to(&message, 8));
        // Notifications have no id and answer nothing.
        assert!(!is_response_to(&parsed(r#"{"method":"x"}"#), 7));
    }
}
