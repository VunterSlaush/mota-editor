//! Mota Extension Protocol (MXP) — pure logic for the extension system:
//! manifest parsing/validation, message building, incoming-line
//! classification, and the permission decision table. No I/O; the shell
//! (`extension_host`, `extension_discovery`) owns processes and files.
//!
//! Protocol: JSON-RPC 2.0, newline-delimited, over the extension's stdio
//! — the same wire family as ACP (see `crate::acp`), deliberately, so an
//! author who has written an MCP server or ACP agent feels at home.
//! Unknown requests get `-32601`; unknown notifications and unknown
//! manifest fields are ignored; unknown PERMISSION strings fail closed
//! (a manifest written for a newer host must never be silently granted).

use serde_json::{json, Map, Value};

pub const PROTOCOL_VERSION: u64 = 1;

/// Everything an extension may be allowed to do. Closed vocabulary:
/// contribution permissions are checked at parse time, host-API
/// permissions at the broker (`required_permission`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Permission {
    CommandsRegister,
    ToolsRegister,
    EventsSubscribe,
    Notifications,
    TranscriptsRead,
    AgentPrompt,
    FsProjectRead,
    UiPanel,
    UiTheme,
    ShellExec,
    ProviderRegister,
}

impl Permission {
    pub fn as_str(self) -> &'static str {
        match self {
            Permission::CommandsRegister => "commands:register",
            Permission::ToolsRegister => "tools:register",
            Permission::EventsSubscribe => "events:subscribe",
            Permission::Notifications => "notifications",
            Permission::TranscriptsRead => "transcripts:read",
            Permission::AgentPrompt => "agent:prompt",
            Permission::FsProjectRead => "fs:project-read",
            Permission::UiPanel => "ui:panel",
            Permission::UiTheme => "ui:theme",
            Permission::ShellExec => "shell:exec",
            Permission::ProviderRegister => "provider:register",
        }
    }

    pub fn parse(value: &str) -> Option<Permission> {
        Some(match value {
            "commands:register" => Permission::CommandsRegister,
            "tools:register" => Permission::ToolsRegister,
            "events:subscribe" => Permission::EventsSubscribe,
            "notifications" => Permission::Notifications,
            "transcripts:read" => Permission::TranscriptsRead,
            "agent:prompt" => Permission::AgentPrompt,
            "fs:project-read" => Permission::FsProjectRead,
            "ui:panel" => Permission::UiPanel,
            "ui:theme" => Permission::UiTheme,
            "shell:exec" => Permission::ShellExec,
            "provider:register" => Permission::ProviderRegister,
            _ => return None,
        })
    }

    /// Rendered with a warning badge in the consent dialog and settings.
    pub fn is_dangerous(self) -> bool {
        matches!(
            self,
            Permission::ShellExec | Permission::AgentPrompt | Permission::ProviderRegister
        )
    }
}

/// A slash command contributed by an extension.
#[derive(Debug, Clone, PartialEq)]
pub struct CommandContribution {
    /// Bare name, no leading slash (`standup`).
    pub name: String,
    pub description: String,
    pub args_hint: Option<String>,
    pub kind: CommandKind,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CommandKind {
    /// Pure data — expanded client-side, no process involved.
    Prompt(PromptSource),
    /// Routed to the extension process as `command/execute`.
    Programmatic,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PromptSource {
    Template(String),
    /// Relative path inside the extension folder (validated: no `..`,
    /// not absolute). The shell reads it.
    File(String),
}

/// An MCP server the extension asks the app to hand to agents — rides
/// the existing `mcpServer` plumbing on the frontend, namespaced there.
#[derive(Debug, Clone, PartialEq)]
pub struct McpContribution {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// A sidebar panel the extension offers (ADR-0013). The host draws the
/// activity-bar icon and asks the process for a declarative view model
/// (`panel/load`, `panel/action`); the extension never renders anything.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelContribution {
    /// Panel id, unique within the extension: `[a-z0-9-]`.
    pub id: String,
    /// Shown as the icon tooltip and the panel heading.
    pub title: String,
    /// Named icon from the host's small fixed set; the host falls back
    /// to a generic one for names it does not know.
    pub icon: Option<String>,
}

/// How to launch the extension process, when it has one. Pure-data
/// extensions (prompt commands, themes) omit it and never spawn.
#[derive(Debug, Clone, PartialEq)]
pub struct EntryPoint {
    pub command: String,
    pub args: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExtensionManifest {
    /// Also the extension id: `[a-z0-9-]`, starts alphanumeric.
    pub name: String,
    pub version: String,
    pub display_name: String,
    pub description: String,
    pub protocol_version: u64,
    pub entry: Option<EntryPoint>,
    pub permissions: Vec<Permission>,
    pub commands: Vec<CommandContribution>,
    pub mcp_servers: Vec<McpContribution>,
    pub panels: Vec<PanelContribution>,
    /// Workbench events the extension wants (`turn/completed`, …).
    pub events: Vec<String>,
    pub idle_timeout_ms: Option<u64>,
}

/// Why a manifest was rejected. `Incompatible` means "written for a
/// newer host" (unknown permission, newer protocol) — shown differently
/// from a plain authoring mistake.
#[derive(Debug, Clone, PartialEq)]
pub enum ManifestError {
    Invalid(String),
    Incompatible(String),
}

impl ManifestError {
    pub fn message(&self) -> &str {
        match self {
            ManifestError::Invalid(m) | ManifestError::Incompatible(m) => m,
        }
    }
}

fn invalid(message: impl Into<String>) -> ManifestError {
    ManifestError::Invalid(message.into())
}

/// Parse and validate one `mota-extension.json`. Unknown fields are
/// ignored (additive manifest evolution); unknown permissions and a
/// newer protocol version fail closed as `Incompatible`.
pub fn parse_manifest(text: &str) -> Result<ExtensionManifest, ManifestError> {
    let root: Value =
        serde_json::from_str(text).map_err(|e| invalid(format!("Not valid JSON: {e}")))?;
    let obj = root
        .as_object()
        .ok_or_else(|| invalid("Manifest must be a JSON object"))?;

    let name = required_string(obj, "name")?;
    if !is_valid_id(&name) {
        return Err(invalid(format!(
            "Invalid extension name (want [a-z0-9-], 2-64 chars): {name}"
        )));
    }
    let version = required_string(obj, "version")?;
    let display_name = optional_string(obj, "displayName").unwrap_or_else(|| name.clone());
    let description = optional_string(obj, "description").unwrap_or_default();

    let protocol_version = obj
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("Missing numeric \"protocolVersion\""))?;
    if protocol_version > PROTOCOL_VERSION {
        return Err(ManifestError::Incompatible(format!(
            "Requires protocol {protocol_version}; this host speaks {PROTOCOL_VERSION}"
        )));
    }

    let mut permissions = Vec::new();
    if let Some(list) = obj.get("permissions") {
        let list = list
            .as_array()
            .ok_or_else(|| invalid("\"permissions\" must be an array of strings"))?;
        for entry in list {
            let text = entry
                .as_str()
                .ok_or_else(|| invalid("\"permissions\" must be an array of strings"))?;
            match Permission::parse(text) {
                Some(permission) => permissions.push(permission),
                None => {
                    return Err(ManifestError::Incompatible(format!(
                        "Unknown permission: {text}"
                    )))
                }
            }
        }
    }
    permissions.sort();
    permissions.dedup();

    let entry = match obj.get("entry") {
        None => None,
        Some(value) => {
            let entry = value
                .as_object()
                .ok_or_else(|| invalid("\"entry\" must be an object"))?;
            Some(EntryPoint {
                command: required_string(entry, "command")?,
                args: string_list(entry.get("args"), "entry.args")?,
            })
        }
    };

    let contributes = obj
        .get("contributes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let commands = parse_commands(&contributes)?;
    let mcp_servers = parse_mcp_servers(&contributes)?;
    let panels = parse_panels(&contributes)?;
    let events = string_list(contributes.get("events"), "contributes.events")?;

    // Contribution permissions are part of informed consent: an extension
    // may only contribute what its manifest asked the user to approve.
    let has = |p: Permission| permissions.contains(&p);
    if !commands.is_empty() && !has(Permission::CommandsRegister) {
        return Err(invalid("Contributing commands requires permission commands:register"));
    }
    if !mcp_servers.is_empty() && !has(Permission::ToolsRegister) {
        return Err(invalid("Contributing MCP servers requires permission tools:register"));
    }
    if !events.is_empty() && !has(Permission::EventsSubscribe) {
        return Err(invalid("Subscribing to events requires permission events:subscribe"));
    }
    if !panels.is_empty() && !has(Permission::UiPanel) {
        return Err(invalid("Contributing panels requires permission ui:panel"));
    }
    let needs_process = commands
        .iter()
        .any(|c| matches!(c.kind, CommandKind::Programmatic))
        || !events.is_empty()
        || !panels.is_empty();
    if needs_process && entry.is_none() {
        return Err(invalid(
            "Programmatic commands, event subscriptions, and panels require an \"entry\" process",
        ));
    }

    Ok(ExtensionManifest {
        name,
        version,
        display_name,
        description,
        protocol_version,
        entry,
        permissions,
        commands,
        mcp_servers,
        panels,
        events,
        idle_timeout_ms: obj.get("idleTimeoutMs").and_then(Value::as_u64),
    })
}

fn parse_commands(
    contributes: &Map<String, Value>,
) -> Result<Vec<CommandContribution>, ManifestError> {
    let Some(list) = contributes.get("commands") else {
        return Ok(Vec::new());
    };
    let list = list
        .as_array()
        .ok_or_else(|| invalid("\"contributes.commands\" must be an array"))?;
    let mut commands = Vec::new();
    for entry in list {
        let obj = entry
            .as_object()
            .ok_or_else(|| invalid("Each command contribution must be an object"))?;
        let name = required_string(obj, "name")?;
        if !is_valid_command_name(&name) {
            return Err(invalid(format!(
                "Invalid command name (want [a-z0-9-], no slash): {name}"
            )));
        }
        let kind = match optional_string(obj, "kind").as_deref() {
            Some("programmatic") => CommandKind::Programmatic,
            Some("prompt") | None => {
                let template = optional_string(obj, "template");
                let file = optional_string(obj, "file");
                match (template, file) {
                    (Some(template), None) => CommandKind::Prompt(PromptSource::Template(template)),
                    (None, Some(file)) => {
                        if !is_safe_relative_path(&file) {
                            return Err(invalid(format!(
                                "Command file must be a relative path inside the extension: {file}"
                            )));
                        }
                        CommandKind::Prompt(PromptSource::File(file))
                    }
                    (None, None) => {
                        return Err(invalid(format!(
                            "Prompt command \"{name}\" needs \"template\" or \"file\""
                        )))
                    }
                    (Some(_), Some(_)) => {
                        return Err(invalid(format!(
                            "Prompt command \"{name}\" must not have both \"template\" and \"file\""
                        )))
                    }
                }
            }
            Some(other) => {
                return Err(invalid(format!(
                    "Unknown command kind \"{other}\" (want prompt or programmatic)"
                )))
            }
        };
        commands.push(CommandContribution {
            name,
            description: optional_string(obj, "description").unwrap_or_default(),
            args_hint: optional_string(obj, "argsHint"),
            kind,
        });
    }
    Ok(commands)
}

fn parse_mcp_servers(
    contributes: &Map<String, Value>,
) -> Result<Vec<McpContribution>, ManifestError> {
    let Some(list) = contributes.get("mcpServers") else {
        return Ok(Vec::new());
    };
    let list = list
        .as_array()
        .ok_or_else(|| invalid("\"contributes.mcpServers\" must be an array"))?;
    let mut servers = Vec::new();
    for entry in list {
        let obj = entry
            .as_object()
            .ok_or_else(|| invalid("Each MCP server contribution must be an object"))?;
        let name = required_string(obj, "name")?;
        if !is_valid_id(&name) {
            return Err(invalid(format!(
                "Invalid MCP server name (want [a-z0-9-]): {name}"
            )));
        }
        let mut env = Vec::new();
        if let Some(map) = obj.get("env") {
            let map = map
                .as_object()
                .ok_or_else(|| invalid("MCP server \"env\" must be an object of strings"))?;
            for (key, value) in map {
                let value = value
                    .as_str()
                    .ok_or_else(|| invalid("MCP server \"env\" must be an object of strings"))?;
                env.push((key.clone(), value.to_owned()));
            }
        }
        servers.push(McpContribution {
            name,
            command: required_string(obj, "command")?,
            args: string_list(obj.get("args"), "mcpServers.args")?,
            env,
        });
    }
    Ok(servers)
}

fn parse_panels(
    contributes: &Map<String, Value>,
) -> Result<Vec<PanelContribution>, ManifestError> {
    let Some(list) = contributes.get("panels") else {
        return Ok(Vec::new());
    };
    let list = list
        .as_array()
        .ok_or_else(|| invalid("\"contributes.panels\" must be an array"))?;
    let mut panels = Vec::new();
    for entry in list {
        let obj = entry
            .as_object()
            .ok_or_else(|| invalid("Each panel contribution must be an object"))?;
        let id = required_string(obj, "id")?;
        if !is_valid_id(&id) {
            return Err(invalid(format!("Invalid panel id (want [a-z0-9-]): {id}")));
        }
        panels.push(PanelContribution {
            id,
            title: required_string(obj, "title")?,
            icon: optional_string(obj, "icon"),
        });
    }
    Ok(panels)
}

fn required_string(obj: &Map<String, Value>, key: &str) -> Result<String, ManifestError> {
    obj.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("Missing required string \"{key}\"")))
}

fn optional_string(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn string_list(value: Option<&Value>, what: &str) -> Result<Vec<String>, ManifestError> {
    match value {
        None => Ok(Vec::new()),
        Some(value) => value
            .as_array()
            .and_then(|list| {
                list.iter()
                    .map(|v| v.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
            })
            .ok_or_else(|| invalid(format!("\"{what}\" must be an array of strings"))),
    }
}

/// Extension ids join filesystem paths and settings keys — keep them
/// boring: lowercase alphanumerics and dashes, no separators of any kind.
pub fn is_valid_id(name: &str) -> bool {
    (2..=64).contains(&name.len())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

fn is_valid_command_name(name: &str) -> bool {
    is_valid_id(name)
}

/// A path an extension supplies for its own folder: relative, no parent
/// traversal, no absolute/drive forms. Cheap textual check — the shell
/// canonicalizes before reading, this only rejects obvious escapes early.
fn is_safe_relative_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains(':')
        && !path.split(['/', '\\']).any(|part| part == "..")
}

// ---- Outgoing messages (host → extension) ----

pub fn initialize_request(
    id: i64,
    extension_id: &str,
    host_version: &str,
    granted_permissions: &[Permission],
    data_dir: &str,
    project_paths: &[String],
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "hostVersion": host_version,
            "extensionId": extension_id,
            "grantedPermissions": granted_permissions.iter().map(|p| p.as_str()).collect::<Vec<_>>(),
            "dataDir": data_dir,
            "projectPaths": project_paths,
        }
    })
}

/// Did the extension's `initialize` result agree on a protocol we speak?
pub fn initialize_accepted(result: &Value) -> bool {
    result
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .is_some_and(|v| v <= PROTOCOL_VERSION)
}

pub fn command_execute_request(
    id: i64,
    command: &str,
    args: &str,
    tab_id: &str,
    project_path: &str,
) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "command/execute",
        "params": {
            "command": command,
            "args": args,
            "context": { "tabId": tab_id, "projectPath": project_path }
        }
    })
}

pub fn panel_load_request(id: i64, panel_id: &str, tab_id: &str, project_path: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "panel/load",
        "params": {
            "panelId": panel_id,
            "context": { "tabId": tab_id, "projectPath": project_path }
        }
    })
}

/// One user interaction inside a panel, routed to the extension. The
/// action vocabulary is host-owned and tiny (ADR-0013): `"open"` — an
/// item was clicked, answer with a `detail`; `"select"` — an item's
/// select control changed to `value`, answer with the updated `view`;
/// `"button"` — a panel-level button (`item_id` is the button id);
/// `"submit"` — the panel input (`item_id` is its id, `value` the text);
/// `"toggle"` — the item's checkbox (`value` is `"true"` or `"false"`);
/// `"remove"` — the item's delete button.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelAction {
    pub action: String,
    pub item_id: String,
    pub value: Option<String>,
}

pub fn panel_action_request(
    id: i64,
    panel_id: &str,
    action: &PanelAction,
    tab_id: &str,
    project_path: &str,
) -> Value {
    let mut params = json!({
        "panelId": panel_id,
        "action": action.action,
        "itemId": action.item_id,
        "context": { "tabId": tab_id, "projectPath": project_path }
    });
    if let Some(value) = &action.value {
        params["value"] = json!(value);
    }
    json!({ "jsonrpc": "2.0", "id": id, "method": "panel/action", "params": params })
}

pub fn event_emit_notification(event: &str, payload: &Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "event/emit",
        "params": { "event": event, "payload": payload }
    })
}

pub fn shutdown_notification() -> Value {
    json!({ "jsonrpc": "2.0", "method": "shutdown" })
}

pub fn ping_request(id: i64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "ping" })
}

// ---- Responses to extension → host requests ----

pub fn method_not_found_response(id: i64, method: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32601, "message": format!("Method not supported by this host: {method}") }
    })
}

pub fn permission_denied_response(id: i64, permission: Permission) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32001, "message": format!("Permission '{}' not granted", permission.as_str()) }
    })
}

pub fn internal_error_response(id: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": -32603, "message": message }
    })
}

pub fn result_response(id: i64, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

// ---- Incoming messages (extension → host) ----

/// One classified line from the extension's stdout.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// Response to one of our requests.
    Response { id: i64, result: Result<Value, String> },
    /// A host-API call from the extension.
    Request { id: i64, method: String, params: Value },
    /// A fire-and-forget notification (`host/log`, `panels/refresh`).
    Notification { method: String, params: Value },
    /// Not JSON-RPC — logged and ignored, never fatal.
    Malformed,
}

pub fn classify(line: &str) -> Incoming {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return Incoming::Malformed;
    };
    let id = message.get("id").and_then(Value::as_i64);
    let method = message.get("method").and_then(Value::as_str);
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    match (id, method) {
        (Some(id), Some(method)) => Incoming::Request {
            id,
            method: method.to_owned(),
            params,
        },
        (None, Some(method)) => Incoming::Notification {
            method: method.to_owned(),
            params,
        },
        (Some(id), None) => {
            let result = match message.get("error") {
                Some(error) => Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown error")
                    .to_owned()),
                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            Incoming::Response { id, result }
        }
        (None, None) => Incoming::Malformed,
    }
}

// ---- The broker's decision table ----

/// What honoring an extension → host method requires.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PermissionCheck {
    /// Always allowed (`host/log`).
    None,
    Needs(Permission),
    /// Not a method this host knows — answer -32601.
    Unknown,
}

pub fn required_permission(method: &str) -> PermissionCheck {
    match method {
        "host/log" | "panels/refresh" => PermissionCheck::None,
        "host/notify" => PermissionCheck::Needs(Permission::Notifications),
        "host/transcripts/read" => PermissionCheck::Needs(Permission::TranscriptsRead),
        "host/fs/read" => PermissionCheck::Needs(Permission::FsProjectRead),
        "host/exec" => PermissionCheck::Needs(Permission::ShellExec),
        "agent/prompt" | "commands/run" => PermissionCheck::Needs(Permission::AgentPrompt),
        _ => PermissionCheck::Unknown,
    }
}

// ---- Events pushed to the frontend over the "extension-event" channel ----

/// Wire shape mirrors `AgentEvent`: serde-tagged, camelCase, additive.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExtensionUiEvent {
    #[serde(rename_all = "camelCase")]
    StatusChanged {
        status: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    NotifyRequested {
        request_id: String,
        title: String,
        body: String,
    },
    #[serde(rename_all = "camelCase")]
    LogLine { line: String },
    /// The extension asked (`panels/refresh`) for its panel to be
    /// re-pulled; the webview re-loads it only if it is open.
    #[serde(rename_all = "camelCase")]
    PanelChanged {
        #[serde(skip_serializing_if = "Option::is_none")]
        panel_id: Option<String>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str = r#"{
        "name": "standup",
        "version": "0.1.0",
        "displayName": "Standup",
        "description": "Daily standup notes.",
        "protocolVersion": 1,
        "entry": { "command": "node", "args": ["./main.js"] },
        "permissions": ["commands:register", "events:subscribe", "notifications"],
        "contributes": {
            "commands": [
                { "name": "standup", "kind": "prompt", "description": "Draft a standup",
                  "argsHint": "[days]", "template": "Summarize the last $ARGUMENTS days." },
                { "name": "standup-refresh", "kind": "programmatic", "description": "Rebuild" }
            ],
            "events": ["turn/completed"]
        }
    }"#;

    #[test]
    fn parses_a_full_manifest() {
        let manifest = parse_manifest(MANIFEST).unwrap();
        assert_eq!(manifest.name, "standup");
        assert_eq!(manifest.display_name, "Standup");
        assert_eq!(manifest.entry.as_ref().unwrap().command, "node");
        assert_eq!(manifest.commands.len(), 2);
        assert_eq!(manifest.events, vec!["turn/completed"]);
        assert!(manifest.permissions.contains(&Permission::Notifications));
        assert_eq!(
            manifest.commands[0].kind,
            CommandKind::Prompt(PromptSource::Template(
                "Summarize the last $ARGUMENTS days.".to_owned()
            ))
        );
        assert_eq!(manifest.commands[1].kind, CommandKind::Programmatic);
    }

    #[test]
    fn unknown_manifest_fields_are_ignored() {
        let text = r#"{ "name": "x-ext", "version": "1", "protocolVersion": 1,
                        "futureField": { "anything": true } }"#;
        assert!(parse_manifest(text).is_ok());
    }

    #[test]
    fn unknown_permission_fails_closed_as_incompatible() {
        let text = r#"{ "name": "x-ext", "version": "1", "protocolVersion": 1,
                        "permissions": ["quantum:entangle"] }"#;
        assert!(matches!(
            parse_manifest(text),
            Err(ManifestError::Incompatible(_))
        ));
    }

    #[test]
    fn newer_protocol_fails_closed_as_incompatible() {
        let text = r#"{ "name": "x-ext", "version": "1", "protocolVersion": 99 }"#;
        assert!(matches!(
            parse_manifest(text),
            Err(ManifestError::Incompatible(_))
        ));
    }

    #[test]
    fn contributions_require_their_permission() {
        let text = r#"{ "name": "x-ext", "version": "1", "protocolVersion": 1,
                        "contributes": { "commands": [
                            { "name": "hi", "template": "Hello" } ] } }"#;
        assert!(matches!(parse_manifest(text), Err(ManifestError::Invalid(_))));
    }

    #[test]
    fn programmatic_commands_require_an_entry() {
        let text = r#"{ "name": "x-ext", "version": "1", "protocolVersion": 1,
                        "permissions": ["commands:register"],
                        "contributes": { "commands": [
                            { "name": "go", "kind": "programmatic" } ] } }"#;
        assert!(matches!(parse_manifest(text), Err(ManifestError::Invalid(_))));
    }

    #[test]
    fn rejects_ids_that_could_escape_a_path_join() {
        for bad in ["../up", "a/b", "a\\b", "UPPER", "a", "-lead", "trail-"] {
            let text = format!(
                r#"{{ "name": "{bad}", "version": "1", "protocolVersion": 1 }}"#
            );
            assert!(parse_manifest(&text).is_err(), "accepted: {bad}");
        }
    }

    #[test]
    fn rejects_prompt_files_that_traverse_upward() {
        let text = r#"{ "name": "x-ext", "version": "1", "protocolVersion": 1,
                        "permissions": ["commands:register"],
                        "contributes": { "commands": [
                            { "name": "hi", "file": "../outside.md" } ] } }"#;
        assert!(parse_manifest(text).is_err());
        let text = r#"{ "name": "x-ext", "version": "1", "protocolVersion": 1,
                        "permissions": ["commands:register"],
                        "contributes": { "commands": [
                            { "name": "hi", "file": "C:\\outside.md" } ] } }"#;
        assert!(parse_manifest(text).is_err());
    }

    #[test]
    fn mcp_contributions_parse_and_gate() {
        let text = r#"{ "name": "x-ext", "version": "1", "protocolVersion": 1,
                        "permissions": ["tools:register"],
                        "contributes": { "mcpServers": [
                            { "name": "tools", "command": "node",
                              "args": ["./mcp.js"], "env": { "A": "1" } } ] } }"#;
        let manifest = parse_manifest(text).unwrap();
        assert_eq!(manifest.mcp_servers.len(), 1);
        assert_eq!(manifest.mcp_servers[0].env, vec![("A".to_owned(), "1".to_owned())]);
        // Same manifest without the permission is rejected.
        let text = text.replace("\"tools:register\"", "\"notifications\"");
        assert!(parse_manifest(&text).is_err());
    }

    #[test]
    fn panel_contributions_parse_and_gate() {
        let text = r#"{ "name": "linear", "version": "1", "protocolVersion": 1,
                        "entry": { "command": "node", "args": ["./main.js"] },
                        "permissions": ["ui:panel"],
                        "contributes": { "panels": [
                            { "id": "tasks", "title": "Linear", "icon": "checklist" } ] } }"#;
        let manifest = parse_manifest(text).unwrap();
        assert_eq!(
            manifest.panels,
            vec![PanelContribution {
                id: "tasks".to_owned(),
                title: "Linear".to_owned(),
                icon: Some("checklist".to_owned()),
            }]
        );
        // The same manifest without the permission is rejected.
        let bare = text.replace("\"ui:panel\"", "\"notifications\"");
        assert!(matches!(parse_manifest(&bare), Err(ManifestError::Invalid(_))));
    }

    #[test]
    fn panels_require_an_entry_process() {
        let text = r#"{ "name": "linear", "version": "1", "protocolVersion": 1,
                        "permissions": ["ui:panel"],
                        "contributes": { "panels": [
                            { "id": "tasks", "title": "Linear" } ] } }"#;
        assert!(matches!(parse_manifest(text), Err(ManifestError::Invalid(_))));
    }

    #[test]
    fn rejects_panel_ids_that_could_escape_a_path_join() {
        let text = r#"{ "name": "linear", "version": "1", "protocolVersion": 1,
                        "entry": { "command": "node" },
                        "permissions": ["ui:panel"],
                        "contributes": { "panels": [
                            { "id": "../up", "title": "X" } ] } }"#;
        assert!(parse_manifest(text).is_err());
    }

    #[test]
    fn panel_requests_carry_the_context() {
        let load = panel_load_request(7, "tasks", "t1", "G:/repo");
        assert_eq!(load["method"], "panel/load");
        assert_eq!(load["params"]["panelId"], "tasks");
        assert_eq!(load["params"]["context"]["projectPath"], "G:/repo");

        let select = panel_action_request(
            8,
            "tasks",
            &PanelAction {
                action: "select".to_owned(),
                item_id: "iss-1".to_owned(),
                value: Some("state-2".to_owned()),
            },
            "t1",
            "G:/repo",
        );
        assert_eq!(select["method"], "panel/action");
        assert_eq!(select["params"]["action"], "select");
        assert_eq!(select["params"]["itemId"], "iss-1");
        assert_eq!(select["params"]["value"], "state-2");

        let open = panel_action_request(
            9,
            "tasks",
            &PanelAction { action: "open".to_owned(), item_id: "iss-1".to_owned(), value: None },
            "t1",
            "G:/repo",
        );
        assert!(open["params"].get("value").is_none());
    }

    #[test]
    fn classify_covers_all_shapes() {
        assert_eq!(
            classify(r#"{"jsonrpc":"2.0","id":3,"result":{"ok":true}}"#),
            Incoming::Response { id: 3, result: Ok(json!({"ok": true})) }
        );
        assert_eq!(
            classify(r#"{"jsonrpc":"2.0","id":3,"error":{"code":-1,"message":"boom"}}"#),
            Incoming::Response { id: 3, result: Err("boom".to_owned()) }
        );
        assert_eq!(
            classify(r#"{"jsonrpc":"2.0","id":9,"method":"host/notify","params":{"title":"t"}}"#),
            Incoming::Request {
                id: 9,
                method: "host/notify".to_owned(),
                params: json!({"title": "t"})
            }
        );
        assert_eq!(
            classify(r#"{"jsonrpc":"2.0","method":"host/log","params":{"message":"m"}}"#),
            Incoming::Notification { method: "host/log".to_owned(), params: json!({"message": "m"}) }
        );
        assert_eq!(classify("not json at all"), Incoming::Malformed);
        assert_eq!(classify("{}"), Incoming::Malformed);
    }

    #[test]
    fn permission_table_is_deny_by_default() {
        assert_eq!(required_permission("host/log"), PermissionCheck::None);
        assert_eq!(
            required_permission("host/notify"),
            PermissionCheck::Needs(Permission::Notifications)
        );
        assert_eq!(
            required_permission("host/exec"),
            PermissionCheck::Needs(Permission::ShellExec)
        );
        assert_eq!(required_permission("host/self_destruct"), PermissionCheck::Unknown);
    }

    #[test]
    fn initialize_round_trip() {
        let message = initialize_request(
            1,
            "standup",
            "0.1.0",
            &[Permission::Notifications],
            "C:/data/extensions-data/standup",
            &["G:/repo".to_owned()],
        );
        assert_eq!(message["method"], "initialize");
        assert_eq!(message["params"]["grantedPermissions"], json!(["notifications"]));
        assert!(initialize_accepted(&json!({ "protocolVersion": 1 })));
        assert!(!initialize_accepted(&json!({ "protocolVersion": 99 })));
        assert!(!initialize_accepted(&json!({})));
    }

    #[test]
    fn error_responses_carry_the_right_codes() {
        assert_eq!(method_not_found_response(4, "x")["error"]["code"], -32601);
        assert_eq!(
            permission_denied_response(4, Permission::ShellExec)["error"]["code"],
            -32001
        );
        assert_eq!(internal_error_response(4, "nope")["error"]["code"], -32603);
    }
}
