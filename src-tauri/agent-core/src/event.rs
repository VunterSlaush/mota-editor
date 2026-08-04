use serde::Serialize;

/// Domain event emitted while an agent works on one turn.
///
/// Serialized shape is the wire contract with the frontend adapter
/// (`src/adapters/tauri/tauriAgentGateway.ts`); both sides use
/// `type`-tagged camelCase objects.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum AgentEvent {
    /// The provider opened (or resumed) a conversation we can come back to.
    SessionStarted { provider_session_id: String },
    /// A complete assistant message.
    AssistantMessage { text: String },
    /// A streamed fragment of the assistant's current message (ACP).
    AssistantDelta { text: String },
    /// A streamed fragment of a USER message (ACP session replay).
    UserDelta { text: String },
    /// A streamed fragment of the agent's reasoning (ACP; verbose view).
    ThoughtDelta { text: String },
    /// The agent's current plan, replaced wholesale on every update (ACP).
    PlanUpdated { entries: Vec<PlanEntry> },
    /// Context-window usage of the tab's session (ACP `usage_update`).
    UsageUpdated { used: u64, size: u64 },
    /// The agent used a tool (ran a command, edited a file, ...).
    ToolUse { name: String, detail: String },
    /// The agent asks the user to approve a tool action (ACP).
    /// `plan_markdown` carries the full plan text when this request is a
    /// plan approval (Claude's plan mode attaches it to the request).
    PermissionRequested {
        request_id: String,
        title: String,
        options: Vec<PermissionOptionInfo>,
        plan_markdown: Option<String>,
        /// Where the agent saved the plan on disk (Claude plan mode).
        plan_file_path: Option<String>,
    },
    /// The agent advertised its currently available slash commands (ACP).
    CommandsUpdated { commands: Vec<AvailableCommand> },
    /// A recoverable error surfaced mid-turn.
    ErrorOccurred { message: String },
    /// The turn finished; no further events will follow.
    TurnCompleted {
        result: Option<String>,
        provider_session_id: Option<String>,
        is_error: bool,
    },
}

/// One step of the agent's plan.
/// `priority`: high | medium | low; `status`: pending | in_progress | completed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEntry {
    pub content: String,
    pub priority: String,
    pub status: String,
}

/// A slash command the agent currently accepts (name includes the `/`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableCommand {
    pub name: String,
    pub description: String,
}

/// One choice the user can pick when an agent requests permission.
/// `kind` is a UI hint (`allow_once`, `allow_always`, `reject_once`,
/// `reject_always`); `option_id` is the agent's opaque id and must be
/// echoed back verbatim.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOptionInfo {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}
