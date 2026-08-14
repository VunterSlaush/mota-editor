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
    QuestionOptionInfo, ToolContent, ToolLocation,
};
use crate::provider::truncate;
use crate::turn::{mode_preamble, Mode, Permission, TurnRequest};

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

/// How to sign a provider in, for the "Sign in" action on the settings
/// screen. Program and args are compile-time constants — nothing here is
/// ever built from user or project input, which is what makes it safe to
/// hand to a terminal emulator further down.
#[derive(Debug, Clone, PartialEq)]
pub struct SignInCommand {
    pub program: &'static str,
    pub args: &'static [&'static str],
    /// What the user will see happen, in one line.
    pub hint: &'static str,
}

impl SignInCommand {
    /// The command as a user would type it — for the copyable fallback
    /// when no terminal can be opened.
    pub fn display(&self) -> String {
        if self.args.is_empty() {
            self.program.to_owned()
        } else {
            format!("{} {}", self.program, self.args.join(" "))
        }
    }
}

/// The sign-in command for a provider, or None when we don't know one.
///
/// These are the vendors' own login entry points; we deliberately do not
/// try to drive the OAuth flow ourselves, because the credential store
/// (macOS Keychain, `~/.claude`, …) belongs to the CLI, not to us.
pub fn sign_in_command(provider_id: &str) -> Option<SignInCommand> {
    match provider_id {
        "claude" => Some(SignInCommand {
            program: "claude",
            args: &["auth", "login"],
            hint: "Opens a terminal and your browser to sign in to Claude.",
        }),
        "codex" => Some(SignInCommand {
            program: "codex",
            args: &["login"],
            hint: "Opens a terminal and your browser to sign in to Codex.",
        }),
        // Gemini has no login subcommand: the CLI signs in on first run.
        "gemini" => Some(SignInCommand {
            program: "gemini",
            args: &[],
            hint: "Opens a terminal running Gemini; use /auth to sign in.",
        }),
        _ => None,
    }
}

/// Does this agent error mean "the user is not signed in"?
///
/// Matched against the adapter's own words, so the list is phrases these
/// CLIs actually emit rather than a generic search for "auth" — a tool
/// named `authorize_payment` failing must not be read as a login problem.
pub fn is_auth_failure(message: &str) -> bool {
    const NEEDLES: [&str; 12] = [
        "oauth session expired",
        "failed to authenticate",
        "authentication_failed",
        "authentication failed",
        "authentication required",
        "auth required",
        "not authenticated",
        "not logged in",
        "please run /login",
        "invalid api key",
        "invalid_api_key",
        "unauthorized",
    ];
    let haystack = message.to_ascii_lowercase();
    NEEDLES.iter().any(|needle| haystack.contains(needle))
}

/// The agent-defined session-mode id that natively enforces our mode,
/// per provider (verified against each adapter's advertised modes).
pub fn native_mode_id(
    provider_id: &str,
    mode: Mode,
    permission: Permission,
) -> Option<&'static str> {
    match (provider_id, mode) {
        // Ask rides plan mode's enforcement: what both need from the CLI
        // is "read anything, write nothing", and that is the only
        // read-only tier either vendor exposes. What separates them is
        // `turn::mode_preamble`, which Ask keeps even here.
        ("claude", Mode::Plan | Mode::Ask) => Some("plan"),
        // Claude's native `auto`: its own permission system approves what
        // it calls safe and asks about the rest — exactly the app's Auto
        // policy, judged by the CLI instead of approximated here.
        ("claude", _) if permission == Permission::Auto => Some("auto"),
        ("claude", _) => Some("default"),
        ("codex", Mode::Plan | Mode::Ask) => Some("read-only"),
        ("codex", _) => Some("agent"),
        _ => None,
    }
}

/// Whether plan mode is natively enforced over ACP for this provider.
pub fn plan_is_native(provider_id: &str) -> bool {
    native_mode_id(provider_id, Mode::Plan, Permission::Manual).is_some()
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
                // Real client-side fs: reads/writes are served by the
                // shell, confined to the project folder.
                "fs": { "readTextFile": true, "writeTextFile": true },
                // Client-owned terminals: the shell runs the command and
                // the UI can mirror its live output.
                "terminal": true,
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
    /// `session/resume` is an extension (advertised via
    /// `sessionCapabilities.resume`): attach to a saved session WITHOUT
    /// replaying it — the cheap alternative to `session/load`.
    pub session_resume: bool,
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
        session_resume: caps.pointer("/sessionCapabilities/resume").is_some(),
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

/// Resume one of the agent's saved sessions WITHOUT the replay: the
/// agent attaches its memory and answers immediately, no
/// `session/update` stream. Draft extension — only send when
/// `sessionCapabilities.resume` was advertised, and be ready to fall
/// back to `session/load` anyway.
pub fn session_resume_request(
    id: i64,
    session_id: &str,
    cwd: &str,
    mcp_servers: &[McpServer],
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/resume",
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

/// Successful `fs/read_text_file` answer.
pub fn fs_read_response(id: i64, content: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": { "content": content } })
}

/// Successful `fs/write_text_file` answer (empty result per spec).
pub fn fs_write_response(id: i64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": {} })
}

/// A request this client understood but could not serve (I/O failure,
/// path outside the project, non-UTF-8 file, unknown terminal id).
pub fn internal_error_response(id: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32603, "message": message }
    })
}

/// Successful `terminal/create` answer.
pub fn terminal_create_response(id: i64, terminal_id: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": { "terminalId": terminal_id } })
}

/// `terminal/output` answer: everything captured so far, whether it was
/// truncated to the byte limit, and the exit status once the command is
/// done.
pub fn terminal_output_response(
    id: i64,
    output: &str,
    truncated: bool,
    exit: Option<(Option<i64>, Option<&str>)>,
) -> Value {
    let mut result = json!({ "output": output, "truncated": truncated });
    if let Some((code, signal)) = exit {
        result["exitStatus"] = json!({ "exitCode": code, "signal": signal });
    }
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// `terminal/wait_for_exit` answer.
pub fn terminal_exit_response(id: i64, code: Option<i64>, signal: Option<&str>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "exitStatus": { "exitCode": code, "signal": signal } }
    })
}

/// `terminal/kill` / `terminal/release` answer (empty result).
pub fn empty_result_response(id: i64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": {} })
}

/// Cap a terminal's retained output at `limit` bytes by dropping from
/// the FRONT (the tail is what the agent and user care about), never
/// splitting a UTF-8 sequence. Returns true when anything was dropped.
pub fn drop_to_byte_limit(buffer: &mut Vec<u8>, limit: usize) -> bool {
    if buffer.len() <= limit {
        return false;
    }
    let mut start = buffer.len() - limit;
    // A continuation byte (0b10xxxxxx) means the cut landed inside a
    // character; move forward to the next boundary.
    while start < buffer.len() && (buffer[start] & 0b1100_0000) == 0b1000_0000 {
        start += 1;
    }
    buffer.drain(..start);
    true
}

/// Slice a file's text per `fs/read_text_file`: `line` is 1-based and
/// `limit` counts lines from there; both optional. A start past EOF
/// yields empty rather than an error — the agent asked about a region
/// that simply has no text.
pub fn slice_lines(text: &str, line: Option<u64>, limit: Option<u64>) -> String {
    let start = line.unwrap_or(1).saturating_sub(1) as usize;
    let take = limit.map(|l| l as usize).unwrap_or(usize::MAX);
    let mut lines = text.lines().skip(start).take(take).collect::<Vec<_>>().join("\n");
    // Preserve a trailing newline when the slice runs to the end of a
    // newline-terminated file.
    if !lines.is_empty() && limit.is_none() && text.ends_with('\n') {
        lines.push('\n');
    }
    lines
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
    /// A permission request offering nothing the user could choose. Shown
    /// as a card it would be a dead end — no buttons, and an agent
    /// waiting on an answer that can never come, which leaves the tab
    /// with a turn that never ends. Cancelled instead, and said out loud.
    UnanswerablePermission { id: i64, title: String },
    /// `session/update` notification, already translated to domain events.
    Updates(Vec<AgentEvent>),
    /// The agent wants to read a file through the client (`fs/read_text_file`).
    FsReadRequest {
        id: i64,
        path: String,
        /// 1-based first line to include, when the agent asked for a slice.
        line: Option<u64>,
        /// Number of lines to include from `line`.
        limit: Option<u64>,
    },
    /// The agent wants to write a file through the client (`fs/write_text_file`).
    FsWriteRequest { id: i64, path: String, content: String },
    /// The agent wants a terminal (`terminal/*`).
    Terminal(TerminalRequest),
    /// Any other request from the agent — must be answered with an error
    /// since we advertise no such capability.
    UnsupportedRequest { id: i64, method: String },
    /// Notification or noise we deliberately ignore.
    Ignored,
}

/// One `terminal/*` request from the agent, already shaped.
#[derive(Debug, Clone, PartialEq)]
pub enum TerminalRequest {
    Create {
        id: i64,
        command: String,
        args: Vec<String>,
        /// Environment as name/value pairs, ACP's wire shape.
        env: Vec<(String, String)>,
        cwd: Option<String>,
        output_byte_limit: Option<u64>,
    },
    Output { id: i64, terminal_id: String },
    WaitForExit { id: i64, terminal_id: String },
    Kill { id: i64, terminal_id: String },
    Release { id: i64, terminal_id: String },
}

/// Parse one `terminal/*` method, or None when the shape is wrong (the
/// caller answers UnsupportedRequest so the agent is never left hanging).
fn classify_terminal(method: &str, id: i64, params: &Value) -> Option<TerminalRequest> {
    let terminal_id = || {
        params
            .get("terminalId")
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    match method {
        "terminal/create" => Some(TerminalRequest::Create {
            id,
            command: params.get("command").and_then(Value::as_str)?.to_owned(),
            args: params
                .get("args")
                .and_then(Value::as_array)
                .map(|args| {
                    args.iter().filter_map(Value::as_str).map(str::to_owned).collect()
                })
                .unwrap_or_default(),
            env: params
                .get("env")
                .and_then(Value::as_array)
                .map(|pairs| {
                    pairs
                        .iter()
                        .filter_map(|pair| {
                            Some((
                                pair.get("name")?.as_str()?.to_owned(),
                                pair.get("value")?.as_str()?.to_owned(),
                            ))
                        })
                        .collect()
                })
                .unwrap_or_default(),
            cwd: params.get("cwd").and_then(Value::as_str).map(str::to_owned),
            output_byte_limit: params.get("outputByteLimit").and_then(Value::as_u64),
        }),
        "terminal/output" => Some(TerminalRequest::Output { id, terminal_id: terminal_id()? }),
        "terminal/wait_for_exit" => {
            Some(TerminalRequest::WaitForExit { id, terminal_id: terminal_id()? })
        }
        "terminal/kill" => Some(TerminalRequest::Kill { id, terminal_id: terminal_id()? }),
        "terminal/release" => {
            Some(TerminalRequest::Release { id, terminal_id: terminal_id()? })
        }
        _ => None,
    }
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
        // Malformed fs requests (no path/content) fall through to the
        // UnsupportedRequest arm below via this guard-less structure —
        // the agent always gets SOME answer, never silence.
        (Some("fs/read_text_file"), Some(id)) => {
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            match params.get("path").and_then(Value::as_str) {
                Some(path) => Some(Incoming::FsReadRequest {
                    id,
                    path: path.to_owned(),
                    line: params.get("line").and_then(Value::as_u64),
                    limit: params.get("limit").and_then(Value::as_u64),
                }),
                None => Some(Incoming::UnsupportedRequest {
                    id,
                    method: "fs/read_text_file (missing path)".to_owned(),
                }),
            }
        }
        (Some("fs/write_text_file"), Some(id)) => {
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            match (
                params.get("path").and_then(Value::as_str),
                params.get("content").and_then(Value::as_str),
            ) {
                (Some(path), Some(content)) => Some(Incoming::FsWriteRequest {
                    id,
                    path: path.to_owned(),
                    content: content.to_owned(),
                }),
                _ => Some(Incoming::UnsupportedRequest {
                    id,
                    method: "fs/write_text_file (missing path or content)".to_owned(),
                }),
            }
        }
        (Some("session/update"), None) => Some(Incoming::Updates(
            value.get("params").map(translate_update).unwrap_or_default(),
        )),
        (Some(method), Some(id)) if method.starts_with("terminal/") => {
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            Some(match classify_terminal(method, id, &params) {
                Some(request) => Incoming::Terminal(request),
                None => Incoming::UnsupportedRequest {
                    id,
                    method: format!("{method} (malformed params)"),
                },
            })
        }
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
    let options: Vec<PermissionOptionInfo> = params
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
    // The same rule the elicitation path follows: a request we cannot
    // render is worse than no request, because the agent blocks on it.
    if options.is_empty() {
        return Incoming::UnanswerablePermission { id, title };
    }
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
            Some(id) => {
                let mut events = vec![AgentEvent::ToolCall {
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
                }];
                // An initial tool_call may already carry content and
                // locations; the ToolCall variant deliberately doesn't
                // (identity vs. payload), so they follow as a synthetic
                // update in the same batch.
                let content = parse_tool_content(update);
                let locations = parse_tool_locations(update);
                if !content.is_empty() || !locations.is_empty() {
                    events.push(AgentEvent::ToolCallUpdate {
                        id: id.to_owned(),
                        status: None,
                        title: None,
                        content,
                        locations,
                    });
                }
                events
            }
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
                    content: parse_tool_content(update),
                    locations: parse_tool_locations(update),
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
    text_or_placeholder(content)
}

/// The text of one content block — or a placeholder for media the app
/// cannot render. A silently swallowed image reads as the agent saying
/// nothing; "[image]" at least says something arrived.
fn text_or_placeholder(content: &Value) -> Option<String> {
    match content.get("type").and_then(Value::as_str)? {
        "text" => content.get("text").and_then(Value::as_str).map(str::to_owned),
        "image" => Some("[image]".to_owned()),
        "audio" => Some("[audio]".to_owned()),
        "resource_link" => {
            let name = content
                .get("name")
                .or_else(|| content.get("uri"))
                .and_then(Value::as_str)
                .unwrap_or("resource");
            Some(format!("[link: {name}]"))
        }
        "resource" => content
            .pointer("/resource/text")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                let uri = content
                    .pointer("/resource/uri")
                    .and_then(Value::as_str)
                    .unwrap_or("resource");
                Some(format!("[resource: {uri}]"))
            }),
        _ => None,
    }
}

/// Tool output can be enormous (a whole test run); the chat row carries
/// this much and the rest is the log's problem.
const TOOL_TEXT_CAP: usize = 4000;

/// Content blocks reported on a `tool_call` / `tool_call_update`.
fn parse_tool_content(update: &Value) -> Vec<ToolContent> {
    update
        .get("content")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(parse_tool_content_item).collect())
        .unwrap_or_default()
}

fn parse_tool_content_item(item: &Value) -> Option<ToolContent> {
    match item.get("type").and_then(Value::as_str)? {
        // A regular content block wrapped for a tool call.
        "content" => {
            let text = text_or_placeholder(item.get("content")?)?;
            Some(ToolContent::Text { text: truncate(&text, TOOL_TEXT_CAP) })
        }
        "diff" => Some(ToolContent::Diff {
            path: item.get("path").and_then(Value::as_str)?.to_owned(),
            old_text: item.get("oldText").and_then(Value::as_str).map(str::to_owned),
            new_text: item.get("newText").and_then(Value::as_str)?.to_owned(),
        }),
        "terminal" => Some(ToolContent::Terminal {
            terminal_id: item.get("terminalId").and_then(Value::as_str)?.to_owned(),
        }),
        _ => None,
    }
}

/// Files (and lines) a tool call reported touching.
fn parse_tool_locations(update: &Value) -> Vec<ToolLocation> {
    update
        .get("locations")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(ToolLocation {
                        path: item.get("path").and_then(Value::as_str)?.to_owned(),
                        line: item
                            .get("line")
                            .and_then(Value::as_u64)
                            .and_then(|line| u32::try_from(line).ok()),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
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
    provider_id: &str,
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
        // A login problem is the one failure the user can always fix, so
        // it gets its own stop reason: the UI turns that into a Sign in
        // button instead of showing the adapter's raw wire error.
        Err(message) if is_auth_failure(message) => AgentEvent::TurnCompleted {
            result: Some(auth_failure_message(provider_id, message)),
            provider_session_id: None,
            is_error: true,
            stop_reason: Some(AUTH_REQUIRED.to_owned()),
        },
        Err(message) => AgentEvent::TurnCompleted {
            result: Some(message.clone()),
            provider_session_id: None,
            is_error: true,
            stop_reason: None,
        },
    }
}

/// Stop reason marking a turn that failed only because nobody is signed
/// in. The frontend keys its Sign in affordance off this exact string.
pub const AUTH_REQUIRED: &str = "auth_required";

/// Plain words for a login failure, keeping the agent's own explanation
/// underneath — the detail is what distinguishes an expired token from a
/// revoked one, and support has no other copy of it.
pub fn auth_failure_message(provider_id: &str, detail: &str) -> String {
    let name = display_name(provider_id);
    match sign_in_command(provider_id) {
        Some(command) => format!(
            "{name} needs you to sign in again. Open Settings → Providers and \
             choose Sign in, or run `{}` in a terminal.\n\n{detail}",
            command.display()
        ),
        None => format!("{name} needs you to sign in again.\n\n{detail}"),
    }
}

fn display_name(provider_id: &str) -> &str {
    match provider_id {
        "claude" => "Claude",
        "codex" => "Codex",
        "gemini" => "Gemini",
        other => other,
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
    fn initialize_declares_version_1_and_full_fs_capabilities() {
        let msg = initialize_request(0);
        assert_eq!(msg["params"]["protocolVersion"], 1);
        assert_eq!(msg["params"]["clientCapabilities"]["fs"]["readTextFile"], true);
        assert_eq!(msg["params"]["clientCapabilities"]["fs"]["writeTextFile"], true);
        assert_eq!(msg["params"]["clientCapabilities"]["terminal"], true);
    }

    #[test]
    fn fs_requests_are_parsed_with_their_slices() {
        let read = r#"{"jsonrpc":"2.0","id":21,"method":"fs/read_text_file","params":{"sessionId":"s","path":"/w/a.ts","line":10,"limit":5}}"#;
        assert_eq!(
            parse_incoming(read),
            Some(Incoming::FsReadRequest {
                id: 21,
                path: "/w/a.ts".into(),
                line: Some(10),
                limit: Some(5),
            })
        );
        let write = r#"{"jsonrpc":"2.0","id":22,"method":"fs/write_text_file","params":{"sessionId":"s","path":"/w/a.ts","content":"hello"}}"#;
        assert_eq!(
            parse_incoming(write),
            Some(Incoming::FsWriteRequest {
                id: 22,
                path: "/w/a.ts".into(),
                content: "hello".into(),
            })
        );
        // Malformed requests still get SOME answer, never silence.
        let broken = r#"{"jsonrpc":"2.0","id":23,"method":"fs/write_text_file","params":{"path":"/w/a.ts"}}"#;
        assert!(matches!(
            parse_incoming(broken),
            Some(Incoming::UnsupportedRequest { id: 23, .. })
        ));
        assert_eq!(fs_read_response(21, "text")["result"]["content"], "text");
        assert_eq!(fs_write_response(22)["result"], json!({}));
        assert_eq!(internal_error_response(23, "nope")["error"]["code"], -32603);
    }

    #[test]
    fn terminal_requests_parse_into_shaped_variants() {
        let create = r#"{"jsonrpc":"2.0","id":31,"method":"terminal/create","params":{
            "sessionId":"s","command":"npm","args":["test"],
            "env":[{"name":"CI","value":"1"}],"cwd":"/w","outputByteLimit":1048576}}"#
            .replace('\n', "");
        assert_eq!(
            parse_incoming(&create),
            Some(Incoming::Terminal(TerminalRequest::Create {
                id: 31,
                command: "npm".into(),
                args: vec!["test".into()],
                env: vec![("CI".into(), "1".into())],
                cwd: Some("/w".into()),
                output_byte_limit: Some(1_048_576),
            }))
        );
        let output = r#"{"jsonrpc":"2.0","id":32,"method":"terminal/output","params":{"sessionId":"s","terminalId":"term-1"}}"#;
        assert_eq!(
            parse_incoming(output),
            Some(Incoming::Terminal(TerminalRequest::Output {
                id: 32,
                terminal_id: "term-1".into()
            }))
        );
        for (method, expect_kill) in
            [("terminal/kill", true), ("terminal/release", false), ("terminal/wait_for_exit", false)]
        {
            let line = format!(
                r#"{{"jsonrpc":"2.0","id":33,"method":"{method}","params":{{"terminalId":"t"}}}}"#
            );
            let parsed = parse_incoming(&line);
            assert!(matches!(parsed, Some(Incoming::Terminal(_))), "{method}: {parsed:?}");
            let _ = expect_kill; // variant shape asserted by the match above
        }
        // Malformed: no command → answered, not ignored.
        let broken = r#"{"jsonrpc":"2.0","id":34,"method":"terminal/create","params":{}}"#;
        assert!(matches!(
            parse_incoming(broken),
            Some(Incoming::UnsupportedRequest { id: 34, .. })
        ));
    }

    #[test]
    fn terminal_responses_have_the_spec_shapes() {
        assert_eq!(terminal_create_response(1, "t-1")["result"]["terminalId"], "t-1");
        let running = terminal_output_response(2, "partial", false, None);
        assert_eq!(running["result"]["output"], "partial");
        assert!(running["result"].get("exitStatus").is_none());
        let done = terminal_output_response(2, "all", true, Some((Some(0), None)));
        assert_eq!(done["result"]["truncated"], true);
        assert_eq!(done["result"]["exitStatus"]["exitCode"], 0);
        assert_eq!(terminal_exit_response(3, Some(1), None)["result"]["exitStatus"]["exitCode"], 1);
        assert_eq!(empty_result_response(4)["result"], json!({}));
    }

    #[test]
    fn output_buffers_drop_from_the_front_at_utf8_boundaries() {
        let mut buffer = "hello world".as_bytes().to_vec();
        assert!(!drop_to_byte_limit(&mut buffer, 100));
        assert!(drop_to_byte_limit(&mut buffer, 5));
        assert_eq!(String::from_utf8(buffer.clone()).unwrap(), "world");
        // Multi-byte: é is two bytes; a cut through it moves forward.
        let mut accented = "aé".as_bytes().to_vec(); // [a, 0xC3, 0xA9]
        assert!(drop_to_byte_limit(&mut accented, 1));
        assert!(String::from_utf8(accented).is_ok());
    }

    #[test]
    fn slice_lines_is_one_based_and_forgiving() {
        let text = "a\nb\nc\nd\n";
        assert_eq!(slice_lines(text, None, None), text);
        assert_eq!(slice_lines(text, Some(2), None), "b\nc\nd\n");
        assert_eq!(slice_lines(text, Some(2), Some(2)), "b\nc");
        assert_eq!(slice_lines(text, Some(99), None), "");
        assert_eq!(slice_lines(text, Some(0), Some(1)), "a"); // 0 treated as 1
        assert_eq!(slice_lines("", None, None), "");
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
        assert!(ok.session_resume);
        assert!(ok.prompt_image);
        assert!(ok.prompt_embedded_context);
        assert_eq!(ok.agent_name.as_deref(), Some("claude-agent-acp"));
        assert_eq!(ok.auth_method_count, 0);

        // Omitted capabilities are unsupported, per spec.
        let bare = parse_initialize_result(&json!({ "protocolVersion": 1 })).unwrap();
        assert!(!bare.load_session);
        assert!(!bare.session_list);
        assert!(!bare.session_resume);

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
        let manual = Permission::Manual;
        assert_eq!(native_mode_id("claude", Mode::Plan, manual), Some("plan"));
        assert_eq!(native_mode_id("claude", Mode::Agent, manual), Some("default"));
        assert_eq!(native_mode_id("codex", Mode::Plan, manual), Some("read-only"));
        assert_eq!(native_mode_id("codex", Mode::Debug, manual), Some("agent"));
        assert_eq!(native_mode_id("gemini", Mode::Plan, manual), None);
        // Auto rides Claude's native auto mode; plan still wins, and the
        // other adapters offer no such tier.
        assert_eq!(native_mode_id("claude", Mode::Agent, Permission::Auto), Some("auto"));
        assert_eq!(native_mode_id("claude", Mode::Plan, Permission::Auto), Some("plan"));
        assert_eq!(native_mode_id("codex", Mode::Agent, Permission::Auto), Some("agent"));
        // Ask borrows the read-only tier, and must keep it even under a
        // permission policy that would otherwise hand it write access.
        assert_eq!(native_mode_id("claude", Mode::Ask, manual), Some("plan"));
        assert_eq!(native_mode_id("claude", Mode::Ask, Permission::Auto), Some("plan"));
        assert_eq!(native_mode_id("claude", Mode::Ask, Permission::Bypass), Some("plan"));
        assert_eq!(native_mode_id("codex", Mode::Ask, manual), Some("read-only"));
        assert_eq!(native_mode_id("codex", Mode::Ask, Permission::Bypass), Some("read-only"));
    }

    #[test]
    fn ask_mode_keeps_its_preamble_on_a_native_provider() {
        // Plan mode's preamble is dropped for Claude because the session
        // mode enforces it. Ask's must not be: the enforcement it
        // borrows is plan's, and the wording is all that says otherwise.
        let request = TurnRequest { mode: Mode::Ask, ..test_request("why is this slow?") };
        let claude = prompt_request_for_provider(3, "s", "claude", &request);
        let text = claude["params"]["prompt"][0]["text"].as_str().unwrap();
        assert!(text.starts_with("You are in ASK MODE."));
        assert!(text.ends_with("why is this slow?"));
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
    fn a_permission_request_with_nothing_to_choose_is_unanswerable() {
        // A card with no buttons cannot be answered, and the agent waits
        // on the answer forever — the tab is then stuck with a turn that
        // can never end. Better to know that here than to draw it.
        let none = r#"{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{
            "sessionId":"s","toolCall":{"toolCallId":"c1","title":"Run npm test"},
            "options":[]}}"#
            .replace('\n', "");
        assert_eq!(
            parse_incoming(&none),
            Some(Incoming::UnanswerablePermission {
                id: 9,
                title: "Run npm test".to_owned()
            })
        );

        // Same outcome by a different route: options we cannot read are
        // options the user cannot click.
        let unreadable = r#"{"jsonrpc":"2.0","id":9,"method":"session/request_permission","params":{
            "sessionId":"s","toolCall":{"toolCallId":"c1","title":"Run npm test"},
            "options":[{"id":"allow","name":"Allow Once","kind":"allow_once"}]}}"#
            .replace('\n', "");
        assert!(matches!(
            parse_incoming(&unreadable),
            Some(Incoming::UnanswerablePermission { .. })
        ));
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
    fn tool_call_updates_carry_content_and_locations() {
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"tool_call_update","toolCallId":"c1","status":"completed",
            "content":[
                {"type":"content","content":{"type":"text","text":"42 passed"}},
                {"type":"diff","path":"/w/a.ts","oldText":"old","newText":"new"},
                {"type":"terminal","terminalId":"term-1"}
            ],
            "locations":[{"path":"/w/a.ts","line":3},{"path":"/w/b.ts"}]}}}"#
            .replace('\n', "");
        match parse_incoming(&line) {
            Some(Incoming::Updates(events)) => match &events[0] {
                AgentEvent::ToolCallUpdate { content, locations, status, .. } => {
                    assert_eq!(status.as_deref(), Some("completed"));
                    assert_eq!(
                        content[0],
                        ToolContent::Text { text: "42 passed".into() }
                    );
                    assert_eq!(
                        content[1],
                        ToolContent::Diff {
                            path: "/w/a.ts".into(),
                            old_text: Some("old".into()),
                            new_text: "new".into(),
                        }
                    );
                    assert_eq!(
                        content[2],
                        ToolContent::Terminal { terminal_id: "term-1".into() }
                    );
                    assert_eq!(
                        locations[0],
                        ToolLocation { path: "/w/a.ts".into(), line: Some(3) }
                    );
                    assert_eq!(
                        locations[1],
                        ToolLocation { path: "/w/b.ts".into(), line: None }
                    );
                }
                other => panic!("unexpected: {other:?}"),
            },
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn initial_tool_calls_with_content_also_emit_a_synthetic_update() {
        let line = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"tool_call","toolCallId":"c1","title":"Edit a.ts","kind":"edit",
            "content":[{"type":"diff","path":"/w/a.ts","newText":"created"}]}}}"#
            .replace('\n', "");
        match parse_incoming(&line) {
            Some(Incoming::Updates(events)) => {
                assert_eq!(events.len(), 2);
                assert!(matches!(events[0], AgentEvent::ToolCall { .. }));
                match &events[1] {
                    AgentEvent::ToolCallUpdate { content, .. } => {
                        // oldText absent = newly created file.
                        assert_eq!(
                            content[0],
                            ToolContent::Diff {
                                path: "/w/a.ts".into(),
                                old_text: None,
                                new_text: "created".into(),
                            }
                        );
                    }
                    other => panic!("unexpected: {other:?}"),
                }
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn non_text_chunks_become_placeholders_not_silence() {
        let image = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"image","data":"...","mimeType":"image/png"}}}}"#
            .replace('\n', "");
        assert_eq!(
            parse_incoming(&image),
            Some(Incoming::Updates(vec![AgentEvent::AssistantDelta {
                text: "[image]".into()
            }]))
        );
        let link = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"resource_link","name":"spec.md","uri":"file:///w/spec.md"}}}}"#
            .replace('\n', "");
        assert_eq!(
            parse_incoming(&link),
            Some(Incoming::Updates(vec![AgentEvent::AssistantDelta {
                text: "[link: spec.md]".into()
            }]))
        );
        // Truly unknown block types still drop.
        let unknown = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s",
            "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"hologram"}}}}"#
            .replace('\n', "");
        assert_eq!(parse_incoming(&unknown), Some(Incoming::Updates(vec![])));
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
        let line = r#"{"jsonrpc":"2.0","id":4,"method":"elicitation/url_dance","params":{}}"#;
        assert_eq!(
            parse_incoming(line),
            Some(Incoming::UnsupportedRequest {
                id: 4,
                method: "elicitation/url_dance".into()
            })
        );
        let response = method_not_found_response(4, "elicitation/url_dance");
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
        let done = completion_from_prompt_result("claude", &Ok(json!({"stopReason":"end_turn"})), false);
        match &done {
            AgentEvent::TurnCompleted { is_error: false, stop_reason: Some(reason), .. } => {
                assert_eq!(reason, "end_turn");
            }
            other => panic!("unexpected: {other:?}"),
        }

        let refused = completion_from_prompt_result("claude", &Ok(json!({"stopReason":"refusal"})), false);
        assert!(matches!(refused, AgentEvent::TurnCompleted { is_error: true, .. }));

        let failed = completion_from_prompt_result("claude", &Err("boom".to_owned()), false);
        match failed {
            AgentEvent::TurnCompleted { result: Some(message), is_error: true, .. } => {
                assert_eq!(message, "boom");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn a_login_failure_becomes_an_actionable_message_not_a_wire_error() {
        // The exact string the Claude adapter sends when its stored
        // OAuth token can no longer be refreshed.
        let raw = "Internal error: Failed to authenticate: OAuth session expired \
                   and could not be refreshed";
        let event = completion_from_prompt_result("claude", &Err(raw.to_owned()), false);
        match event {
            AgentEvent::TurnCompleted {
                result: Some(message),
                is_error: true,
                stop_reason: Some(reason),
                ..
            } => {
                assert_eq!(reason, AUTH_REQUIRED);
                assert!(message.starts_with("Claude needs you to sign in again."));
                assert!(message.contains("claude auth login"));
                // The adapter's own words survive: they are the only
                // thing that separates an expired token from a revoked
                // one when the user asks for help.
                assert!(message.contains(raw));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn a_cancelled_login_failure_is_still_just_a_cancellation() {
        let event = completion_from_prompt_result(
            "claude",
            &Err("Failed to authenticate".to_owned()),
            true,
        );
        assert!(matches!(
            event,
            AgentEvent::TurnCompleted { is_error: false, .. }
        ));
    }

    #[test]
    fn auth_detection_reads_the_clis_own_words_not_any_mention_of_auth() {
        for message in [
            "Failed to authenticate: OAuth session expired and could not be refreshed",
            "API Error: 401 Unauthorized",
            "Not logged in. Please run /login",
            "invalid api key",
        ] {
            assert!(is_auth_failure(message), "should detect: {message}");
        }
        for message in [
            "the tool `authorize_payment` returned a non-zero exit code",
            "Could not read file: permission denied",
            "",
        ] {
            assert!(!is_auth_failure(message), "should not detect: {message}");
        }
    }

    #[test]
    fn every_provider_offers_a_sign_in_command_and_none_is_invented() {
        assert_eq!(sign_in_command("claude").unwrap().display(), "claude auth login");
        assert_eq!(sign_in_command("codex").unwrap().display(), "codex login");
        assert_eq!(sign_in_command("gemini").unwrap().display(), "gemini");
        assert!(sign_in_command("nobody").is_none());
    }

    #[test]
    fn truncated_and_cancelled_turns_keep_their_stop_reason_without_erroring() {
        // A reply cut short by limits is not a success to pass off
        // silently, but not an error either — the reason travels.
        let capped = completion_from_prompt_result("claude", &Ok(json!({"stopReason":"max_tokens"})), false);
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
        let stopped = completion_from_prompt_result("claude", &Err("Cancelled.".to_owned()), true);
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
