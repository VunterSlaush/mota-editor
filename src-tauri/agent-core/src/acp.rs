//! Agent Client Protocol (ACP) — pure protocol logic: message building,
//! incoming-line classification, and translation of `session/update`
//! notifications into domain [`AgentEvent`]s. No I/O; the shell owns the
//! process and the wire.
//!
//! Protocol: JSON-RPC 2.0, newline-delimited, over the agent's stdio.
//! Spec: <https://agentclientprotocol.com> (protocolVersion 1).

use serde_json::{json, Value};

use crate::event::{
    AgentEvent, AvailableCommand, PermissionOptionInfo, PlanEntry, QuestionInfo,
    QuestionOptionInfo,
};
use crate::provider::truncate;
use crate::turn::{mode_preamble, Mode, TurnRequest};

pub const PROTOCOL_VERSION: u64 = 1;

/// How to launch a provider's ACP agent (adapter or native flag).
#[derive(Debug, Clone, PartialEq)]
pub struct AcpAgentCommand {
    pub program: String,
    pub args: Vec<String>,
    /// Shown to the user when the agent can't start.
    pub install_hint: &'static str,
}

/// Launch candidates for a provider's ACP agent, fastest first: the
/// globally-installed binary (instant), then `npx` (resolves — and on
/// first use downloads — the package, which is why global install is
/// recommended). The shell tries them in order.
pub fn agent_commands(provider_id: &str) -> Vec<AcpAgentCommand> {
    match provider_id {
        "claude" => vec![
            AcpAgentCommand {
                program: "claude-agent-acp".to_owned(),
                args: vec![],
                install_hint: "npm i -g @agentclientprotocol/claude-agent-acp",
            },
            AcpAgentCommand {
                program: "npx".to_owned(),
                args: vec!["-y".to_owned(), "@agentclientprotocol/claude-agent-acp".to_owned()],
                install_hint: "npm i -g @agentclientprotocol/claude-agent-acp",
            },
        ],
        "codex" => vec![
            AcpAgentCommand {
                program: "codex-acp".to_owned(),
                args: vec![],
                install_hint: "npm i -g @agentclientprotocol/codex-acp",
            },
            AcpAgentCommand {
                program: "npx".to_owned(),
                args: vec!["-y".to_owned(), "@agentclientprotocol/codex-acp".to_owned()],
                install_hint: "npm i -g @agentclientprotocol/codex-acp",
            },
        ],
        "gemini" => vec![AcpAgentCommand {
            program: "gemini".to_owned(),
            args: vec!["--acp".to_owned()],
            install_hint: "npm i -g @google/gemini-cli",
        }],
        _ => vec![],
    }
}

/// Environment variables that select the model and reasoning effort for
/// a provider's ACP agent. Applied at spawn — changing either restarts
/// the tab's session.
///
/// Effort vocabulary (researched 2026-08): Claude via
/// `CLAUDE_CODE_EFFORT_LEVEL` (low|medium|high|xhigh|max); Codex via
/// `model_reasoning_effort` in `CODEX_CONFIG`
/// (minimal|low|medium|high|xhigh); Gemini exposes no effort control.
pub fn agent_env(
    provider_id: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> Vec<(String, String)> {
    match provider_id {
        "claude" => {
            let mut env = Vec::new();
            if let Some(model) = model {
                env.push(("ANTHROPIC_MODEL".to_owned(), model.to_owned()));
            }
            if let Some(effort) = effort {
                env.push(("CLAUDE_CODE_EFFORT_LEVEL".to_owned(), effort.to_owned()));
            }
            env
        }
        "codex" => {
            let mut config = serde_json::Map::new();
            if let Some(model) = model {
                config.insert("model".to_owned(), Value::String(model.to_owned()));
            }
            if let Some(effort) = effort {
                config.insert(
                    "model_reasoning_effort".to_owned(),
                    Value::String(effort.to_owned()),
                );
            }
            if config.is_empty() {
                vec![]
            } else {
                vec![("CODEX_CONFIG".to_owned(), Value::Object(config).to_string())]
            }
        }
        "gemini" => model
            .map(|m| vec![("GEMINI_MODEL".to_owned(), m.to_owned())])
            .unwrap_or_default(),
        _ => vec![],
    }
}

/// The agent-defined session-mode id that natively enforces our mode,
/// per provider (verified against each adapter's advertised modes).
pub fn native_mode_id(provider_id: &str, mode: Mode) -> Option<&'static str> {
    match (provider_id, mode) {
        ("claude", Mode::Plan) => Some("plan"),
        ("claude", _) => Some("default"),
        ("codex", Mode::Plan) => Some("read-only"),
        ("codex", _) => Some("agent"),
        _ => None,
    }
}

/// Whether plan mode is natively enforced over ACP for this provider.
pub fn plan_is_native(provider_id: &str) -> bool {
    native_mode_id(provider_id, Mode::Plan).is_some()
}

// ---- Outgoing messages (client → agent) ----

pub fn initialize_request(id: i64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": {
                "fs": { "readTextFile": false, "writeTextFile": false },
                "terminal": false,
                // Declaring form elicitation is what lets the agent ASK the
                // user things. Claude's adapter puts `AskUserQuestion` in
                // `disallowedTools` unless this is present, so without it
                // the model is told the tool does not exist and has to
                // guess instead. `{}` is the spec's "supported" value.
                // URL elicitation is deliberately not advertised: it would
                // send the user out to a browser mid-turn.
                "elicitation": { "form": {} }
            },
            "clientInfo": {
                "name": "mota-editor",
                "title": "Mota Editor",
                "version": env!("CARGO_PKG_VERSION")
            }
        }
    })
}

/// What the agent advertised at `initialize` — the parts this client
/// acts on. Omitted capabilities parse as unsupported, per spec.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AgentCaps {
    pub load_session: bool,
    /// `session/list` is an extension (advertised via
    /// `sessionCapabilities.list`); never call it unadvertised.
    pub session_list: bool,
    pub prompt_image: bool,
    pub prompt_embedded_context: bool,
    pub agent_name: Option<String>,
    pub auth_method_count: usize,
}

/// Read the `initialize` response. Errs when the agent answered with a
/// protocol version this client does not speak — per spec the agent
/// must respond with a version ≤ ours, so anything newer means the two
/// sides would talk past each other.
pub fn parse_initialize_result(result: &Value) -> Result<AgentCaps, String> {
    let version = result
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .ok_or("The agent reported no protocol version.")?;
    if version > PROTOCOL_VERSION {
        return Err(format!(
            "The agent speaks ACP v{version}; this app speaks v{PROTOCOL_VERSION}. \
             Update the app (or pin an older agent adapter)."
        ));
    }
    let caps = result.get("agentCapabilities").cloned().unwrap_or(Value::Null);
    Ok(AgentCaps {
        load_session: caps.get("loadSession").and_then(Value::as_bool).unwrap_or(false),
        session_list: caps.pointer("/sessionCapabilities/list").is_some(),
        prompt_image: caps
            .pointer("/promptCapabilities/image")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        prompt_embedded_context: caps
            .pointer("/promptCapabilities/embeddedContext")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        agent_name: result
            .pointer("/agentInfo/name")
            .and_then(Value::as_str)
            .map(str::to_owned),
        auth_method_count: result
            .get("authMethods")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0),
    })
}

/// Session modes as `session/new` reported them: what the agent is in
/// now, and which ids `session/set_mode` may name.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SessionModes {
    pub current: Option<String>,
    pub available: Vec<String>,
}

/// Read the `session/new` result: the session id plus the mode state.
pub fn parse_session_new_result(result: &Value) -> (Option<String>, SessionModes) {
    let session_id = result
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let modes = SessionModes {
        current: result
            .pointer("/modes/currentModeId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        available: result
            .pointer("/modes/availableModes")
            .and_then(Value::as_array)
            .map(|modes| {
                modes
                    .iter()
                    .filter_map(|m| m.get("id").and_then(Value::as_str))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
    };
    (session_id, modes)
}

/// The MCP servers a session is created with. Mota passes what the user
/// configured; the agent adds whatever its own config already loaded, and
/// the protocol gives us no way to see that half.
pub fn session_new_request(id: i64, cwd: &str, mcp_servers: &[McpServer]) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/new",
        "params": { "cwd": cwd, "mcpServers": mcp_server_params(mcp_servers) }
    })
}

/// One stdio MCP server, in ACP's shape.
#[derive(Debug, Clone, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

/// ACP wants env as a list of name/value pairs, not an object.
fn mcp_server_params(servers: &[McpServer]) -> Value {
    Value::Array(
        servers
            .iter()
            .map(|server| {
                json!({
                    "name": server.name,
                    "command": server.command,
                    "args": server.args,
                    "env": server
                        .env
                        .iter()
                        .map(|(name, value)| json!({ "name": name, "value": value }))
                        .collect::<Vec<_>>(),
                })
            })
            .collect(),
    )
}

/// List the agent's own saved sessions for this project.
pub fn session_list_request(id: i64, cwd: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/list",
        "params": { "cwd": cwd }
    })
}

/// Load (truly resume) one of the agent's saved sessions: the agent
/// replays the whole conversation as `session/update` notifications,
/// then continues WITH that context in memory.
pub fn session_load_request(
    id: i64,
    session_id: &str,
    cwd: &str,
    mcp_servers: &[McpServer],
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/load",
        "params": {
            "sessionId": session_id,
            "cwd": cwd,
            "mcpServers": mcp_server_params(mcp_servers)
        }
    })
}

pub fn set_mode_request(id: i64, session_id: &str, mode_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/set_mode",
        "params": { "sessionId": session_id, "modeId": mode_id }
    })
}

pub fn cancel_notification(session_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "session/cancel",
        "params": { "sessionId": session_id }
    })
}

pub fn permission_selected_response(id: i64, option_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "outcome": { "outcome": "selected", "optionId": option_id } }
    })
}

pub fn permission_cancelled_response(id: i64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "outcome": { "outcome": "cancelled" } }
    })
}

/// The user answered the agent's questions. `answers` maps form field to
/// the chosen (or typed) text; fields the user skipped are simply absent,
/// which the agent reads as "no answer for that one".
pub fn elicitation_accept_response(id: i64, answers: &[(String, String)]) -> Value {
    let content: serde_json::Map<String, Value> = answers
        .iter()
        .map(|(field, value)| (field.clone(), Value::String(value.clone())))
        .collect();
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "action": "accept", "content": Value::Object(content) }
    })
}

/// The user chose not to answer. The agent carries on without the answers
/// rather than aborting the turn.
pub fn elicitation_declined_response(id: i64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": { "action": "decline" } })
}

/// The turn was cancelled out from under the question; the agent aborts
/// the tool call.
pub fn elicitation_cancelled_response(id: i64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": { "action": "cancel" } })
}

pub fn method_not_found_response(id: i64, method: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32601, "message": format!("Method not supported by this client: {method}") }
    })
}

/// The prompt request for one turn: mode preamble folded into the text
/// block (skipped when the mode is enforced natively via
/// `session/set_mode`); attachments as baseline `resource_link` blocks.
pub fn prompt_request_for_provider(
    id: i64,
    session_id: &str,
    provider_id: &str,
    request: &TurnRequest,
) -> Value {
    let text = match mode_preamble(request.mode, plan_is_native(provider_id)) {
        Some(preamble) => format!("{preamble}\n\n{}", request.prompt),
        None => request.prompt.clone(),
    };
    let mut blocks = vec![json!({ "type": "text", "text": text })];
    for path in &request.attachments {
        blocks.push(json!({
            "type": "resource_link",
            "uri": file_uri(path),
            "name": file_name(path),
        }));
    }
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/prompt",
        "params": { "sessionId": session_id, "prompt": blocks }
    })
}

fn file_uri(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        format!("file://{normalized}")
    } else {
        format!("file:///{normalized}")
    }
}

fn file_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_owned()
}

// ---- Incoming messages (agent → client) ----

/// One classified line from the agent's stdout.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// Response to one of our requests.
    Response { id: i64, result: Result<Value, String> },
    /// The agent asks the user to approve a tool action.
    PermissionRequest {
        id: i64,
        title: String,
        options: Vec<PermissionOptionInfo>,
        /// The plan text, when this is a plan approval (plan mode).
        plan_markdown: Option<String>,
        /// Where the agent saved the plan on disk, when it did.
        plan_file_path: Option<String>,
        /// The tool call this request guards, when the agent named it.
        tool_call_id: Option<String>,
        /// ACP kind of the guarded tool call (`switch_mode` marks a plan
        /// approval authoritatively).
        tool_kind: Option<String>,
    },
    /// The agent asks the user a question (form elicitation).
    ElicitationRequest {
        id: i64,
        message: String,
        questions: Vec<QuestionInfo>,
    },
    /// An elicitation we advertised no support for (url mode). Declined
    /// rather than errored: the agent should carry on, not fail the turn.
    UnsupportedElicitation { id: i64 },
    /// `session/update` notification, already translated to domain events.
    Updates(Vec<AgentEvent>),
    /// Any other request from the agent (fs/terminal/...) — must be
    /// answered with an error since we advertise no such capabilities.
    UnsupportedRequest { id: i64, method: String },
    /// Notification or noise we deliberately ignore.
    Ignored,
}

pub fn parse_incoming(line: &str) -> Option<Incoming> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    let method = value.get("method").and_then(Value::as_str);
    let id = value.get("id").and_then(Value::as_i64);

    match (method, id) {
        (None, Some(id)) => Some(classify_response(id, &value)),
        (Some("session/request_permission"), Some(id)) => {
            Some(classify_permission_request(id, &value))
        }
        (Some("elicitation/create"), Some(id)) => Some(classify_elicitation(id, &value)),
        (Some("session/update"), None) => Some(Incoming::Updates(
            value.get("params").map(translate_update).unwrap_or_default(),
        )),
        (Some(method), Some(id)) => Some(Incoming::UnsupportedRequest {
            id,
            method: method.to_owned(),
        }),
        _ => Some(Incoming::Ignored),
    }
}

fn classify_response(id: i64, value: &Value) -> Incoming {
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Unknown agent error")
            .to_owned();
        return Incoming::Response { id, result: Err(message) };
    }
    Incoming::Response {
        id,
        result: Ok(value.get("result").cloned().unwrap_or(Value::Null)),
    }
}

fn classify_permission_request(id: i64, value: &Value) -> Incoming {
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let title = params
        .pointer("/toolCall/title")
        .and_then(Value::as_str)
        .unwrap_or("The agent wants to perform an action")
        .to_owned();
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .map(|options| options.iter().filter_map(parse_option).collect())
        .unwrap_or_default();
    // Plan mode attaches the full plan to the approval request
    // (Claude's ExitPlanMode tool input: {"plan": "<markdown>"}).
    let plan_markdown = params
        .pointer("/toolCall/rawInput/plan")
        .and_then(Value::as_str)
        .filter(|p| !p.trim().is_empty())
        .map(str::to_owned);
    let plan_file_path = params
        .pointer("/toolCall/rawInput/planFilePath")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let tool_call_id = params
        .pointer("/toolCall/toolCallId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let tool_kind = params
        .pointer("/toolCall/kind")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Incoming::PermissionRequest {
        id,
        title,
        options,
        plan_markdown,
        plan_file_path,
        tool_call_id,
        tool_kind,
    }
}

/// Marker the agent puts on the free-text field that accompanies a
/// select question. Deliberately un-namespaced in the protocol so every
/// AskUserQuestion bridge (Claude, Codex, ...) can be recognised alike.
const CUSTOM_ANSWER_META: &str = "_askUserQuestionCustomAnswer";

/// Classify an `elicitation/create` request. Only form mode is supported
/// (it is the only mode we advertise); anything else is declined.
fn classify_elicitation(id: i64, value: &Value) -> Incoming {
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    if params.get("mode").and_then(Value::as_str) != Some("form") {
        return Incoming::UnsupportedElicitation { id };
    }
    let message = params
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("The agent has a question")
        .to_owned();
    let questions = parse_elicitation_questions(&params, &message);
    if questions.is_empty() {
        // A form we cannot render is worse than no form: declining lets
        // the agent proceed instead of waiting on a card that never came.
        return Incoming::UnsupportedElicitation { id };
    }
    Incoming::ElicitationRequest { id, message, questions }
}

/// Read the questions out of an elicitation's `requestedSchema`.
///
/// The shape is a JSON Schema object whose properties are the form
/// fields. Select fields carry their choices in `oneOf` (single) or
/// `items.anyOf` (multi); each choice's `const` is the value to send
/// back and its `title` is what to show. Alongside each select sits an
/// optional free-text field marked with `CUSTOM_ANSWER_META`, which is
/// folded into its question rather than listed as a question of its own.
fn parse_elicitation_questions(params: &Value, message: &str) -> Vec<QuestionInfo> {
    let Some(properties) = params
        .pointer("/requestedSchema/properties")
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };

    // Custom-answer fields, indexed by the question they belong to.
    let mut custom_for: std::collections::BTreeMap<String, String> = Default::default();
    for (field, schema) in properties {
        if let Some(owner) = custom_answer_owner(schema) {
            custom_for.insert(owner, field.clone());
        }
    }

    let mut questions: Vec<QuestionInfo> = Vec::new();
    for (field, schema) in properties {
        if custom_answer_owner(schema).is_some() {
            continue; // folded into its question below
        }
        let options = parse_question_options(schema);
        if options.is_empty() {
            continue; // a free-text-only field is not a choice we can render
        }
        questions.push(QuestionInfo {
            // With one question the text lives in `message` and the field
            // description is omitted; with several, each carries its own.
            text: schema
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or(message)
                .to_owned(),
            header: schema
                .get("title")
                .and_then(Value::as_str)
                .filter(|t| !t.trim().is_empty())
                .map(str::to_owned),
            multi_select: schema.get("type").and_then(Value::as_str) == Some("array"),
            custom_field: custom_for.get(field).cloned(),
            field: field.clone(),
            options,
        });
    }
    questions
}

/// The question field a free-text "Other" box belongs to, if it is one.
fn custom_answer_owner(schema: &Value) -> Option<String> {
    let meta = schema.pointer("/_meta")?.get(CUSTOM_ANSWER_META)?;
    meta.get("questionId")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// The choices of a select field: `oneOf` for single, `items.anyOf` for
/// multi-select.
fn parse_question_options(schema: &Value) -> Vec<QuestionOptionInfo> {
    let list = schema
        .get("oneOf")
        .or_else(|| schema.pointer("/items/anyOf"))
        .and_then(Value::as_array);
    list.map(|options| options.iter().filter_map(parse_question_option).collect())
        .unwrap_or_default()
}

fn parse_question_option(value: &Value) -> Option<QuestionOptionInfo> {
    // `const` is what the agent reads back; without it we'd be guessing.
    let constant = value.get("const")?.as_str()?.to_owned();
    Some(QuestionOptionInfo {
        label: value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(&constant)
            .to_owned(),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .filter(|d| !d.trim().is_empty())
            .map(str::to_owned),
        value: constant,
    })
}

fn parse_option(value: &Value) -> Option<PermissionOptionInfo> {
    Some(PermissionOptionInfo {
        option_id: value.get("optionId")?.as_str()?.to_owned(),
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Option")
            .to_owned(),
        kind: value
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("allow_once")
            .to_owned(),
    })
}

/// The option to auto-select under bypass permissions: a one-time allow
/// when offered, otherwise any allow. `None` when the agent offered no
/// allow option at all — the request then goes to the user instead of
/// silently picking a rejection on their behalf.
pub fn bypass_choice(options: &[PermissionOptionInfo]) -> Option<&PermissionOptionInfo> {
    options
        .iter()
        .find(|o| o.kind == "allow_once")
        .or_else(|| options.iter().find(|o| o.kind.starts_with("allow")))
}

/// Whether a permission request is a PLAN APPROVAL — the agent presenting
/// its plan and asking to proceed. These must ALWAYS reach the user, even
/// under bypass permissions: approving a plan is the whole point of plan
/// mode. The guarded tool call's ACP `kind` is authoritative when it says
/// `switch_mode`; otherwise fall back to the mode-switch option ids agents
/// attach to exit-plan requests (Claude: auto/acceptEdits/default/plan/...)
/// and to the request title. The title check matches "plan" as a whole
/// word only: tool titles quote the command being run, and a substring
/// match turned any command mentioning `roofPlane` or `planner.ts` into a
/// "plan approval" that bypass refused to answer.
pub fn is_plan_approval(
    title: &str,
    options: &[PermissionOptionInfo],
    tool_kind: Option<&str>,
) -> bool {
    if tool_kind == Some("switch_mode") {
        return true;
    }
    const MODE_SWITCH_IDS: [&str; 5] =
        ["plan", "acceptEdits", "default", "auto", "bypassPermissions"];
    let has_mode_switch_option = options
        .iter()
        .any(|o| MODE_SWITCH_IDS.contains(&o.option_id.as_str()));
    has_mode_switch_option
        || title
            .to_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .any(|word| word == "plan")
}

/// Translate `session/update` params into domain events.
fn translate_update(params: &Value) -> Vec<AgentEvent> {
    let update = params.get("update").unwrap_or(params);
    match update.get("sessionUpdate").and_then(Value::as_str) {
        Some("agent_message_chunk") => text_of(update)
            .map(|text| vec![AgentEvent::AssistantDelta { text }])
            .unwrap_or_default(),
        Some("user_message_chunk") => text_of(update)
            .map(|text| vec![AgentEvent::UserDelta { text }])
            .unwrap_or_default(),
        Some("agent_thought_chunk") => text_of(update)
            .map(|text| vec![AgentEvent::ThoughtDelta { text }])
            .unwrap_or_default(),
        Some("plan") => vec![AgentEvent::PlanUpdated {
            entries: update
                .get("entries")
                .and_then(Value::as_array)
                .map(|entries| entries.iter().filter_map(parse_plan_entry).collect())
                .unwrap_or_default(),
        }],
        Some("tool_call") => match update.get("toolCallId").and_then(Value::as_str) {
            Some(id) => vec![AgentEvent::ToolCall {
                id: id.to_owned(),
                kind: update
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("other")
                    .to_owned(),
                title: truncate(
                    update.get("title").and_then(Value::as_str).unwrap_or_default(),
                    200,
                ),
                status: update
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("pending")
                    .to_owned(),
            }],
            // No id means no way to correlate updates: degrade to the
            // legacy flat row rather than dropping the activity.
            None => vec![AgentEvent::ToolUse {
                name: update
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_owned(),
                detail: truncate(
                    update.get("title").and_then(Value::as_str).unwrap_or_default(),
                    200,
                ),
            }],
        },
        Some("tool_call_update") => update
            .get("toolCallId")
            .and_then(Value::as_str)
            .map(|id| {
                vec![AgentEvent::ToolCallUpdate {
                    id: id.to_owned(),
                    status: update
                        .get("status")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    title: update
                        .get("title")
                        .and_then(Value::as_str)
                        .map(|t| truncate(t, 200)),
                    content: Vec::new(),
                    locations: Vec::new(),
                }]
            })
            .unwrap_or_default(),
        Some("current_mode_update") => update
            .get("currentModeId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(|id| vec![AgentEvent::ModeChanged { mode_id: id.to_owned() }])
            .unwrap_or_default(),
        Some("usage_update") => {
            let used = update.get("used").and_then(Value::as_u64);
            let size = update.get("size").and_then(Value::as_u64);
            match (used, size) {
                (Some(used), Some(size)) if size > 0 => {
                    vec![AgentEvent::UsageUpdated { used, size }]
                }
                _ => Vec::new(),
            }
        }
        Some("available_commands_update") => vec![AgentEvent::CommandsUpdated {
            commands: update
                .get("availableCommands")
                .and_then(Value::as_array)
                .map(|commands| commands.iter().filter_map(parse_command).collect())
                .unwrap_or_default(),
        }],
        // Session info and unknown update kinds: tolerated per spec
        // ("ignore unknown updates").
        _ => Vec::new(),
    }
}

fn parse_plan_entry(value: &Value) -> Option<PlanEntry> {
    let content = value.get("content")?.as_str()?.trim();
    (!content.is_empty()).then(|| PlanEntry {
        content: content.to_owned(),
        priority: value
            .get("priority")
            .and_then(Value::as_str)
            .unwrap_or("medium")
            .to_owned(),
        status: value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("pending")
            .to_owned(),
    })
}

/// ACP advertises names without the slash; the palette (and the way a
/// command is invoked — as `/name` prompt text) uses the slash form.
fn parse_command(value: &Value) -> Option<AvailableCommand> {
    let name = value.get("name")?.as_str()?.trim();
    (!name.is_empty()).then(|| AvailableCommand {
        name: format!("/{name}"),
        description: truncate(
            value.get("description").and_then(Value::as_str).unwrap_or_default(),
            120,
        ),
    })
}

fn text_of(update: &Value) -> Option<String> {
    let content = update.get("content")?;
    match content.get("type").and_then(Value::as_str)? {
        "text" => content.get("text").and_then(Value::as_str).map(str::to_owned),
        _ => None,
    }
}

/// Map a `session/prompt` result to the turn-completion event.
///
/// Only `refusal` is an error. `max_tokens`/`max_turn_requests` complete
/// the turn normally but keep their stop reason so the UI can warn that
/// the reply was cut short instead of passing truncation off as success.
/// `was_cancelled` marks a turn the user stopped (including the cancel
/// watchdog forcing a wedged prompt down): not an error, reason
/// "cancelled".
pub fn completion_from_prompt_result(
    result: &Result<Value, String>,
    was_cancelled: bool,
) -> AgentEvent {
    if was_cancelled {
        return AgentEvent::TurnCompleted {
            result: None,
            provider_session_id: None,
            is_error: false,
            stop_reason: Some("cancelled".to_owned()),
        };
    }
    match result {
        Ok(value) => {
            let stop_reason = value
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("end_turn");
            AgentEvent::TurnCompleted {
                result: (stop_reason == "refusal")
                    .then(|| "The agent declined to continue this request.".to_owned()),
                provider_session_id: None,
                is_error: stop_reason == "refusal",
                stop_reason: Some(stop_reason.to_owned()),
            }
        }
        Err(message) => AgentEvent::TurnCompleted {
            result: Some(message.clone()),
            provider_session_id: None,
            is_error: true,
            stop_reason: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::turn::test_request;

    #[test]
    fn every_provider_has_acp_launch_candidates_fastest_first() {
        for provider in ["claude", "codex", "gemini"] {
            assert!(!agent_commands(provider).is_empty(), "{provider}");
        }
        // Global binary is tried before npx for the adapter-based agents.
        assert_eq!(agent_commands("claude")[0].program, "claude-agent-acp");
        assert_eq!(agent_commands("codex")[0].program, "codex-acp");
        assert!(agent_commands("unknown").is_empty());
    }

    #[test]
    fn agent_env_maps_model_and_effort_per_vendor() {
        assert_eq!(
            agent_env("claude", Some("fable"), Some("xhigh")),
            vec![
                ("ANTHROPIC_MODEL".to_owned(), "fable".to_owned()),
                ("CLAUDE_CODE_EFFORT_LEVEL".to_owned(), "xhigh".to_owned()),
            ]
        );
        assert_eq!(
            agent_env("codex", Some("gpt-5.5"), Some("high")),
            vec![(
                "CODEX_CONFIG".to_owned(),
                "{\"model\":\"gpt-5.5\",\"model_reasoning_effort\":\"high\"}".to_owned()
            )]
        );
        // Gemini exposes no effort control; model only.
        assert_eq!(
            agent_env("gemini", Some("gemini-3-pro-preview"), Some("high")),
            vec![("GEMINI_MODEL".to_owned(), "gemini-3-pro-preview".to_owned())]
        );
        assert!(agent_env("claude", None, None).is_empty());
        assert!(agent_env("codex", None, None).is_empty());
    }

    #[test]
    fn available_commands_updates_become_command_events_with_slash_names() {
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"available_commands_update","availableCommands":[
                {"name":"compact","description":"Summarize the conversation"},
                {"name":"init","description":"Create CLAUDE.md"}]}}}"#
            .replace('\n', "");
        match parse_incoming(&line) {
            Some(Incoming::Updates(events)) => match &events[0] {
                AgentEvent::CommandsUpdated { commands } => {
                    assert_eq!(commands.len(), 2);
                    assert_eq!(commands[0].name, "/compact");
                    assert_eq!(commands[1].name, "/init");
                }
                other => panic!("unexpected: {other:?}"),
            },
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn initialize_declares_version_1_and_no_fs_capabilities() {
        let msg = initialize_request(0);
        assert_eq!(msg["params"]["protocolVersion"], 1);
        assert_eq!(msg["params"]["clientCapabilities"]["fs"]["readTextFile"], false);
    }

    #[test]
    fn initialize_result_parses_capabilities_and_rejects_newer_protocols() {
        // Shape captured from claude-agent-acp 0.64.2.
        let ok = parse_initialize_result(&json!({
            "protocolVersion": 1,
            "agentCapabilities": {
                "promptCapabilities": { "image": true, "embeddedContext": true },
                "loadSession": true,
                "sessionCapabilities": { "list": {}, "resume": {} }
            },
            "agentInfo": { "name": "claude-agent-acp", "version": "0.64.2" },
            "authMethods": []
        }))
        .unwrap();
        assert!(ok.load_session);
        assert!(ok.session_list);
        assert!(ok.prompt_image);
        assert!(ok.prompt_embedded_context);
        assert_eq!(ok.agent_name.as_deref(), Some("claude-agent-acp"));
        assert_eq!(ok.auth_method_count, 0);

        // Omitted capabilities are unsupported, per spec.
        let bare = parse_initialize_result(&json!({ "protocolVersion": 1 })).unwrap();
        assert!(!bare.load_session);
        assert!(!bare.session_list);

        // A newer protocol than ours means the two sides would talk past
        // each other — refuse instead of limping.
        assert!(parse_initialize_result(&json!({ "protocolVersion": 2 })).is_err());
        assert!(parse_initialize_result(&json!({})).is_err());
    }

    #[test]
    fn session_new_result_parses_id_and_modes() {
        let (id, modes) = parse_session_new_result(&json!({
            "sessionId": "s1",
            "modes": {
                "currentModeId": "default",
                "availableModes": [
                    { "id": "default", "name": "Manual" },
                    { "id": "plan", "name": "Plan Mode" }
                ]
            }
        }));
        assert_eq!(id.as_deref(), Some("s1"));
        assert_eq!(modes.current.as_deref(), Some("default"));
        assert_eq!(modes.available, vec!["default", "plan"]);

        let (bare_id, bare_modes) = parse_session_new_result(&json!({ "sessionId": "s2" }));
        assert_eq!(bare_id.as_deref(), Some("s2"));
        assert_eq!(bare_modes, SessionModes::default());
    }

    #[test]
    fn initialize_advertises_form_elicitation_but_not_url() {
        // Claude's adapter disallows the AskUserQuestion tool outright
        // unless form elicitation is advertised, so this is the whole
        // reason the agent can ask anything at all.
        let caps = &initialize_request(0)["params"]["clientCapabilities"];
        assert_eq!(caps["elicitation"]["form"], json!({}));
        assert!(caps["elicitation"].get("url").is_none());
    }

    /// The exact wire shape `claude-agent-acp` sends for AskUserQuestion.
    fn ask_line(params: &str) -> String {
        format!(r#"{{"jsonrpc":"2.0","id":11,"method":"elicitation/create","params":{params}}}"#)
    }

    #[test]
    fn a_single_question_takes_its_text_from_the_message() {
        let line = ask_line(
            r#"{"mode":"form","sessionId":"s","toolCallId":"t1",
                "message":"Which database should I use?",
                "requestedSchema":{"type":"object","properties":{
                  "question_0":{"type":"string","title":"Database",
                    "oneOf":[
                      {"const":"Postgres","title":"Postgres","description":"Relational"},
                      {"const":"SQLite","title":"SQLite"}]},
                  "question_0_custom":{"type":"string","title":"Other",
                    "_meta":{"_askUserQuestionCustomAnswer":{"questionId":"question_0","isCustomAnswer":true}}}
                }}}"#,
        );
        match parse_incoming(&line.replace('\n', "")) {
            Some(Incoming::ElicitationRequest { id, message, questions }) => {
                assert_eq!(id, 11);
                assert_eq!(message, "Which database should I use?");
                assert_eq!(questions.len(), 1, "the Other box is not its own question");

                let q = &questions[0];
                assert_eq!(q.field, "question_0");
                assert_eq!(q.header.as_deref(), Some("Database"));
                // No per-field description for a single question: the
                // message carries the text.
                assert_eq!(q.text, "Which database should I use?");
                assert!(!q.multi_select);
                assert_eq!(q.custom_field.as_deref(), Some("question_0_custom"));
                assert_eq!(q.options.len(), 2);
                assert_eq!(q.options[0].value, "Postgres");
                assert_eq!(q.options[0].description.as_deref(), Some("Relational"));
                // Missing title falls back to the value.
                assert_eq!(q.options[1].label, "SQLite");
                assert_eq!(q.options[1].description, None);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn several_questions_each_carry_their_own_text_and_multi_select() {
        let line = ask_line(
            r#"{"mode":"form","sessionId":"s",
                "message":"Please answer the following questions.",
                "requestedSchema":{"type":"object","properties":{
                  "question_0":{"type":"string","description":"Which runtime?",
                    "oneOf":[{"const":"node","title":"Node"}]},
                  "question_1":{"type":"array","description":"Which extras?",
                    "items":{"anyOf":[
                      {"const":"lint","title":"Lint"},
                      {"const":"test","title":"Tests"}]}}
                }}}"#,
        );
        match parse_incoming(&line.replace('\n', "")) {
            Some(Incoming::ElicitationRequest { questions, .. }) => {
                assert_eq!(questions.len(), 2);
                assert_eq!(questions[0].text, "Which runtime?");
                assert!(!questions[0].multi_select);
                assert_eq!(questions[0].custom_field, None);

                assert_eq!(questions[1].text, "Which extras?");
                assert!(questions[1].multi_select, "array fields are multi-select");
                assert_eq!(questions[1].options.len(), 2);
                assert_eq!(questions[1].options[1].value, "test");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn url_and_unrenderable_elicitations_are_declined_not_errored() {
        // We never advertise url mode, but a server MCP could still try.
        let url = ask_line(r#"{"mode":"url","sessionId":"s","url":"https://x","message":"Sign in"}"#);
        assert_eq!(
            parse_incoming(&url),
            Some(Incoming::UnsupportedElicitation { id: 11 })
        );

        // A form with no choices is not something this UI can render.
        let empty = ask_line(
            r#"{"mode":"form","sessionId":"s","message":"Type something",
                "requestedSchema":{"type":"object","properties":{
                  "freeform":{"type":"string","title":"Notes"}}}}"#,
        );
        assert_eq!(
            parse_incoming(&empty.replace('\n', "")),
            Some(Incoming::UnsupportedElicitation { id: 11 })
        );
    }

    #[test]
    fn elicitation_responses_use_the_action_shapes_the_agent_expects() {
        let answers = vec![("question_0".to_owned(), "Postgres".to_owned())];
        let accept = elicitation_accept_response(11, &answers);
        assert_eq!(accept["result"]["action"], "accept");
        assert_eq!(accept["result"]["content"]["question_0"], "Postgres");

        assert_eq!(elicitation_declined_response(11)["result"]["action"], "decline");
        assert_eq!(elicitation_cancelled_response(11)["result"]["action"], "cancel");
    }

    #[test]
    fn an_accept_with_no_answers_still_sends_an_object() {
        // Skipping every question must not serialize `content` as null:
        // the agent validates the shape before reading it.
        let accept = elicitation_accept_response(11, &[]);
        assert_eq!(accept["result"]["content"], json!({}));
    }

    #[test]
    fn session_new_sends_cwd_and_no_servers_when_none_are_configured() {
        let msg = session_new_request(1, "/work/alpha", &[]);
        assert_eq!(msg["params"]["cwd"], "/work/alpha");
        assert_eq!(msg["params"]["mcpServers"], json!([]));
    }

    fn test_server() -> McpServer {
        McpServer {
            name: "files".to_owned(),
            command: "npx".to_owned(),
            args: vec!["-y".to_owned(), "@modelcontextprotocol/server-filesystem".to_owned()],
            env: [("ROOT".to_owned(), "/work".to_owned())].into_iter().collect(),
        }
    }

    #[test]
    fn session_new_passes_configured_servers_through() {
        let msg = session_new_request(1, "/work/alpha", &[test_server()]);
        let servers = msg["params"]["mcpServers"].as_array().unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0]["name"], "files");
        assert_eq!(servers[0]["command"], "npx");
        assert_eq!(servers[0]["args"][0], "-y");
    }

    #[test]
    fn env_is_sent_as_name_value_pairs_not_an_object() {
        let msg = session_new_request(1, "/work/alpha", &[test_server()]);
        let env = &msg["params"]["mcpServers"][0]["env"];
        assert_eq!(env, &json!([{ "name": "ROOT", "value": "/work" }]));
    }

    #[test]
    fn resuming_a_session_carries_the_same_servers() {
        let msg = session_load_request(1, "sess_1", "/work/alpha", &[test_server()]);
        assert_eq!(msg["params"]["sessionId"], "sess_1");
        assert_eq!(msg["params"]["mcpServers"][0]["name"], "files");
    }

    #[test]
    fn prompt_includes_attachments_as_resource_links() {
        let request = TurnRequest {
            attachments: vec!["C:\\docs\\spec.pdf".to_owned()],
            ..test_request("read the spec")
        };
        let msg = prompt_request_for_provider(2, "sess_1", "claude", &request);
        let blocks = msg["params"]["prompt"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], "text");
        assert_eq!(blocks[1]["type"], "resource_link");
        assert_eq!(blocks[1]["uri"], "file:///C:/docs/spec.pdf");
        assert_eq!(blocks[1]["name"], "spec.pdf");
    }

    #[test]
    fn plan_preamble_is_skipped_when_the_provider_enforces_plan_natively() {
        let request = TurnRequest { mode: Mode::Plan, ..test_request("plan it") };
        let claude = prompt_request_for_provider(3, "s", "claude", &request);
        assert_eq!(claude["params"]["prompt"][0]["text"], "plan it");

        let gemini = prompt_request_for_provider(3, "s", "gemini", &request);
        let text = gemini["params"]["prompt"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("You are in PLAN MODE."));
    }

    #[test]
    fn native_mode_ids_match_the_adapters() {
        assert_eq!(native_mode_id("claude", Mode::Plan), Some("plan"));
        assert_eq!(native_mode_id("claude", Mode::Agent), Some("default"));
        assert_eq!(native_mode_id("codex", Mode::Plan), Some("read-only"));
        assert_eq!(native_mode_id("codex", Mode::Debug), Some("agent"));
        assert_eq!(native_mode_id("gemini", Mode::Plan), None);
    }

    #[test]
    fn responses_are_classified_with_result_or_error() {
        let ok = parse_incoming(r#"{"jsonrpc":"2.0","id":7,"result":{"stopReason":"end_turn"}}"#);
        assert!(matches!(ok, Some(Incoming::Response { id: 7, result: Ok(_) })));

        let err = parse_incoming(r#"{"jsonrpc":"2.0","id":8,"error":{"code":-32000,"message":"auth required"}}"#);
        match err {
            Some(Incoming::Response { id: 8, result: Err(message) }) => {
                assert_eq!(message, "auth required");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn permission_requests_carry_title_and_options() {
        let line = r#"{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{
            "sessionId":"s","toolCall":{"toolCallId":"c1","title":"Run npm test"},
            "options":[{"optionId":"allow","name":"Allow Once","kind":"allow_once"},
                       {"optionId":"reject","name":"Deny","kind":"reject_once"}]}}"#
            .replace('\n', "");
        match parse_incoming(&line) {
            Some(Incoming::PermissionRequest { id, title, options, plan_markdown, .. }) => {
                assert_eq!(id, 9);
                assert_eq!(title, "Run npm test");
                assert_eq!(options.len(), 2);
                assert_eq!(options[0].option_id, "allow");
                assert_eq!(plan_markdown, None);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn plan_mode_approvals_carry_the_plan_markdown() {
        let line = r##"{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{
            "sessionId":"s",
            "toolCall":{"toolCallId":"c1","title":"Ready to code?","rawInput":{"plan":"# My Plan\n\n1. Add the port\n2. Wire it","planFilePath":"/home/u/.claude/plans/p.md"}},
            "options":[{"optionId":"acceptEdits","name":"Yes","kind":"allow_once"}]}}"##
            .replace("\n            ", "");
        match parse_incoming(&line) {
            Some(Incoming::PermissionRequest {
                plan_markdown: Some(plan),
                plan_file_path: Some(path),
                ..
            }) => {
                assert!(plan.starts_with("# My Plan"));
                assert!(path.ends_with("p.md"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn message_chunks_become_assistant_deltas() {
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hel"}}}}"#
            .replace('\n', "");
        assert_eq!(
            parse_incoming(&line),
            Some(Incoming::Updates(vec![AgentEvent::AssistantDelta { text: "Hel".into() }]))
        );
    }

    #[test]
    fn tool_calls_become_tool_call_events() {
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"tool_call","toolCallId":"c1","title":"Reading config","kind":"read"}}}"#
            .replace('\n', "");
        assert_eq!(
            parse_incoming(&line),
            Some(Incoming::Updates(vec![AgentEvent::ToolCall {
                id: "c1".into(),
                kind: "read".into(),
                title: "Reading config".into(),
                status: "pending".into(),
            }]))
        );
    }

    #[test]
    fn tool_calls_without_an_id_degrade_to_legacy_tool_use() {
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"tool_call","title":"Reading config","kind":"read"}}}"#
            .replace('\n', "");
        assert_eq!(
            parse_incoming(&line),
            Some(Incoming::Updates(vec![AgentEvent::ToolUse {
                name: "read".into(),
                detail: "Reading config".into()
            }]))
        );
    }

    #[test]
    fn tool_call_updates_become_tool_call_update_events() {
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"completed"}}}"#
            .replace('\n', "");
        assert_eq!(
            parse_incoming(&line),
            Some(Incoming::Updates(vec![AgentEvent::ToolCallUpdate {
                id: "c1".into(),
                status: Some("completed".into()),
                title: None,
                content: Vec::new(),
                locations: Vec::new(),
            }]))
        );
        // Title-only updates keep status untouched; unknown status strings
        // pass through verbatim (forward-compatible).
        let retitled = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"tool_call_update","toolCallId":"c2","title":"New title","status":"weird"}}}"#
            .replace('\n', "");
        assert_eq!(
            parse_incoming(&retitled),
            Some(Incoming::Updates(vec![AgentEvent::ToolCallUpdate {
                id: "c2".into(),
                status: Some("weird".into()),
                title: Some("New title".into()),
                content: Vec::new(),
                locations: Vec::new(),
            }]))
        );
        // No toolCallId → nothing to correlate → dropped.
        let anonymous = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"tool_call_update","status":"completed"}}}"#
            .replace('\n', "");
        assert_eq!(parse_incoming(&anonymous), Some(Incoming::Updates(vec![])));
    }

    #[test]
    fn current_mode_updates_become_mode_changed_events() {
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"current_mode_update","currentModeId":"plan"}}}"#
            .replace('\n', "");
        assert_eq!(
            parse_incoming(&line),
            Some(Incoming::Updates(vec![AgentEvent::ModeChanged { mode_id: "plan".into() }]))
        );
        let empty = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"current_mode_update"}}}"#
            .replace('\n', "");
        assert_eq!(parse_incoming(&empty), Some(Incoming::Updates(vec![])));
    }

    #[test]
    fn usage_updates_are_translated() {
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"usage_update","used":33350,"size":200000}}}"#
            .replace('\n', "");
        assert_eq!(
            parse_incoming(&line),
            Some(Incoming::Updates(vec![AgentEvent::UsageUpdated { used: 33350, size: 200000 }]))
        );
    }

    #[test]
    fn unknown_updates_are_tolerated() {
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"session_info_update","title":"x"}}}"#
            .replace('\n', "");
        assert_eq!(parse_incoming(&line), Some(Incoming::Updates(vec![])));
    }

    #[test]
    fn other_agent_requests_are_flagged_unsupported() {
        let line = r#"{"jsonrpc":"2.0","id":4,"method":"fs/read_text_file","params":{}}"#;
        assert_eq!(
            parse_incoming(line),
            Some(Incoming::UnsupportedRequest { id: 4, method: "fs/read_text_file".into() })
        );
        let response = method_not_found_response(4, "fs/read_text_file");
        assert_eq!(response["error"]["code"], -32601);
    }

    #[test]
    fn thought_chunks_and_plans_are_translated() {
        let thought = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Hmm"}}}}"#
            .replace('\n', "");
        assert_eq!(
            parse_incoming(&thought),
            Some(Incoming::Updates(vec![AgentEvent::ThoughtDelta { text: "Hmm".into() }]))
        );

        let plan = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"plan","entries":[
                {"content":"Add the port","priority":"high","status":"in_progress"},
                {"content":"Wire the adapter","priority":"medium","status":"pending"}]}}}"#
            .replace('\n', "");
        match parse_incoming(&plan) {
            Some(Incoming::Updates(events)) => match &events[0] {
                AgentEvent::PlanUpdated { entries } => {
                    assert_eq!(entries.len(), 2);
                    assert_eq!(entries[0].content, "Add the port");
                    assert_eq!(entries[0].status, "in_progress");
                }
                other => panic!("unexpected: {other:?}"),
            },
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn plan_approvals_are_detected_by_mode_switch_options_or_title() {
        let opt = |id: &str, kind: &str| PermissionOptionInfo {
            option_id: id.to_owned(),
            name: id.to_owned(),
            kind: kind.to_owned(),
        };
        // The guarded tool call's kind is authoritative when present.
        assert!(is_plan_approval(
            "Anything at all",
            &[opt("allow", "allow_once")],
            Some("switch_mode")
        ));
        // Claude's exit-plan request: options switch the session mode.
        assert!(is_plan_approval(
            "Ready to code?",
            &[opt("acceptEdits", "allow_once"), opt("plan", "reject_once")],
            None
        ));
        // Title fallback.
        assert!(is_plan_approval("Approve this plan", &[opt("allow", "allow_once")], None));
        // A normal tool request is not a plan approval.
        assert!(!is_plan_approval(
            "Run npm test",
            &[opt("allow", "allow_once"), opt("reject", "reject_once")],
            None
        ));
        // An ordinary execute kind does not make it one either.
        assert!(!is_plan_approval(
            "Run npm test",
            &[opt("allow", "allow_once"), opt("reject", "reject_once")],
            Some("execute")
        ));
        // "plan" must match as a whole word: a command that merely
        // mentions roofPlane is an ordinary tool request.
        assert!(!is_plan_approval(
            "git commit -m \"align the roofPlane accent\"",
            &[opt("allow", "allow_once"), opt("reject", "reject_once")],
            None
        ));
    }

    #[test]
    fn bypass_prefers_a_one_time_allow() {
        let options = vec![
            PermissionOptionInfo { option_id: "always".into(), name: "Always".into(), kind: "allow_always".into() },
            PermissionOptionInfo { option_id: "once".into(), name: "Once".into(), kind: "allow_once".into() },
            PermissionOptionInfo { option_id: "no".into(), name: "Deny".into(), kind: "reject_once".into() },
        ];
        assert_eq!(bypass_choice(&options).unwrap().option_id, "once");
    }

    #[test]
    fn bypass_never_auto_picks_a_rejection() {
        // An agent offering only reject options must reach the user, not
        // be silently declined on their behalf.
        let reject_only = vec![PermissionOptionInfo {
            option_id: "no".into(),
            name: "Deny".into(),
            kind: "reject_once".into(),
        }];
        assert_eq!(bypass_choice(&reject_only), None);
        assert_eq!(bypass_choice(&[]), None);
    }

    #[test]
    fn prompt_result_maps_to_completion() {
        let done = completion_from_prompt_result(&Ok(json!({"stopReason":"end_turn"})), false);
        match &done {
            AgentEvent::TurnCompleted { is_error: false, stop_reason: Some(reason), .. } => {
                assert_eq!(reason, "end_turn");
            }
            other => panic!("unexpected: {other:?}"),
        }

        let refused = completion_from_prompt_result(&Ok(json!({"stopReason":"refusal"})), false);
        assert!(matches!(refused, AgentEvent::TurnCompleted { is_error: true, .. }));

        let failed = completion_from_prompt_result(&Err("boom".to_owned()), false);
        match failed {
            AgentEvent::TurnCompleted { result: Some(message), is_error: true, .. } => {
                assert_eq!(message, "boom");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn truncated_and_cancelled_turns_keep_their_stop_reason_without_erroring() {
        // A reply cut short by limits is not a success to pass off
        // silently, but not an error either — the reason travels.
        let capped = completion_from_prompt_result(&Ok(json!({"stopReason":"max_tokens"})), false);
        assert_eq!(
            capped,
            AgentEvent::TurnCompleted {
                result: None,
                provider_session_id: None,
                is_error: false,
                stop_reason: Some("max_tokens".into()),
            }
        );
        // A user-stopped turn resolves as cancelled even when the wire
        // call failed (the watchdog force-fails wedged prompts).
        let stopped = completion_from_prompt_result(&Err("Cancelled.".to_owned()), true);
        assert_eq!(
            stopped,
            AgentEvent::TurnCompleted {
                result: None,
                provider_session_id: None,
                is_error: false,
                stop_reason: Some("cancelled".into()),
            }
        );
    }
}
