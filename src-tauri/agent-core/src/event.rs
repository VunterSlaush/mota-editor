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
    /// Legacy shape: headless providers and the fallback notice. The ACP
    /// path emits `ToolCall`/`ToolCallUpdate` instead.
    ToolUse { name: String, detail: String },
    /// A tool call began (ACP `tool_call`). `id` correlates updates.
    /// `kind` is ACP's category (read|edit|execute|search|think|fetch|...),
    /// `status` its lifecycle (pending|in_progress|completed|failed).
    ToolCall {
        id: String,
        kind: String,
        title: String,
        status: String,
    },
    /// A tool call progressed (ACP `tool_call_update`). Only fields the
    /// agent sent are present; `content`/`locations` replace prior values
    /// when non-empty (ACP update semantics).
    ToolCallUpdate {
        id: String,
        status: Option<String>,
        title: Option<String>,
        content: Vec<ToolContent>,
        locations: Vec<ToolLocation>,
    },
    /// The agent switched its own session mode (ACP `current_mode_update`).
    ModeChanged { mode_id: String },
    /// Where session startup currently stands (installing|booting|
    /// creating|recovering|ready). Purely informational for the UI.
    SessionStage { stage: String },
    /// Something worth telling the user happened to their session, but
    /// nothing went wrong — rendered as an `info` row in the transcript,
    /// not an error. Used to make silent, costly work visible: an agent
    /// restarted to apply a setting re-sends the whole conversation, and
    /// a charge the user cannot see is a charge they cannot avoid.
    Notice { message: String },
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
        /// The tool call this request guards, when the agent named it —
        /// lets the UI preview what is being approved.
        tool_call_id: Option<String>,
    },
    /// The agent asks the user a question (ACP form elicitation — Claude's
    /// `AskUserQuestion`). Unlike a permission request this is not about
    /// consent: the agent is stuck on a decision only the user can make.
    QuestionAsked {
        request_id: String,
        /// Shown above the questions; for a single question it IS the question.
        message: String,
        questions: Vec<QuestionInfo>,
    },
    /// The agent advertised its currently available slash commands (ACP).
    CommandsUpdated { commands: Vec<AvailableCommand> },
    /// A recoverable error surfaced mid-turn. `context` is a stable
    /// machine-readable tag ("agent-exited", "session-not-restored", ...);
    /// `stderr_tail` carries the agent's last stderr lines when relevant.
    ErrorOccurred {
        message: String,
        context: Option<String>,
        stderr_tail: Option<String>,
    },
    /// The turn finished; no further events will follow. `stop_reason` is
    /// ACP's verbatim stopReason (end_turn|max_tokens|max_turn_requests|
    /// refusal|cancelled) when the turn ran over ACP.
    TurnCompleted {
        result: Option<String>,
        provider_session_id: Option<String>,
        is_error: bool,
        stop_reason: Option<String>,
    },
}

/// One piece of a tool call's reported output (ACP content block).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ToolContent {
    /// Plain (or placeholder) text output.
    Text { text: String },
    /// A file change the agent reported: full old/new contents.
    /// `old_text` is absent for a newly created file.
    Diff {
        path: String,
        old_text: Option<String>,
        new_text: String,
    },
    /// A live terminal owned by the client (`terminal/create`).
    Terminal { terminal_id: String },
}

/// A file (and optionally line) a tool call touched.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLocation {
    pub path: String,
    pub line: Option<u32>,
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

/// One question in an elicitation form.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionInfo {
    /// The form field this answer belongs to (`question_0`), echoed back.
    pub field: String,
    /// Short heading the agent gave the question, when it gave one.
    pub header: Option<String>,
    /// The question itself.
    pub text: String,
    pub options: Vec<QuestionOptionInfo>,
    /// True when the user may pick several options.
    pub multi_select: bool,
    /// Field for a typed-in answer, when the form offers one.
    pub custom_field: Option<String>,
}

/// One answer the user can pick for a question.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOptionInfo {
    /// The value written back into the form field.
    pub value: String,
    pub label: String,
    pub description: Option<String>,
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
