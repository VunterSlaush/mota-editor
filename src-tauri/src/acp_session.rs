//! ACP session manager — persistent Agent Client Protocol sessions, one
//! per tab. Owns the agent subprocess and the wire; all protocol logic
//! (message shapes, classification, translation) lives in
//! `agent_core::acp`, which keeps this file mechanical: spawn, route,
//! respond.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
// Locks recover from poisoning: the guarded state (session maps,
// pending-call tables) stays coherent even if a holder panicked, and
// permanently wedging every future turn is the worse failure.
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use agent_core::acp;
use agent_core::{AgentEvent, TurnRequest};
use serde_json::Value;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;

use crate::runner;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(120); // first npx run downloads the adapter
const SET_MODE_TIMEOUT: Duration = Duration::from_secs(10);

/// Why an ACP turn could not start.
pub enum AcpStartError {
    /// The agent isn't installed/launchable — fall back to headless mode.
    Unavailable(String),
    /// The agent started but the request failed — surface, don't fall back.
    Failed(String),
}

#[derive(Default)]
pub struct AcpSessions(Mutex<HashMap<String, Arc<AcpSession>>>);

pub struct AcpSession {
    provider_id: String,
    /// Model the agent was spawned with (env-based; change = respawn).
    model: Option<String>,
    /// Effort the agent was spawned with (env-based; change = respawn).
    effort: Option<String>,
    /// Servers passed at session creation (fixed then; change = respawn).
    mcp_servers: Vec<acp::McpServer>,
    /// The agent-side session this tab currently talks to. Set after
    /// `session/new`, replaced when a saved session is loaded (resume).
    session_id: Mutex<String>,
    child: Mutex<Option<Child>>,
    stdin: tokio::sync::Mutex<ChildStdin>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>,
    pending_permissions: Mutex<Vec<i64>>,
    /// Request id of the in-flight `session/prompt`, for the cancel
    /// watchdog: a cancelled turn whose response never arrives must not
    /// leave the tab stuck busy forever.
    current_turn: Mutex<Option<i64>>,
    bypass: AtomicBool,
    /// True while the current turn runs in plan mode — auto-approval is
    /// fully disabled then: approving the plan is the user's call.
    plan_mode: AtomicBool,
    turn_active: AtomicBool,
}

impl AcpSessions {
    fn get(&self, tab_id: &str) -> Option<Arc<AcpSession>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).get(tab_id).cloned()
    }

    pub fn end_session(&self, tab_id: &str) {
        if let Some(session) = self.0.lock().unwrap_or_else(PoisonError::into_inner).remove(tab_id) {
            session.shutdown();
        }
    }
}

impl AcpSession {
    fn request_id(&self) -> i64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    fn sid(&self) -> String {
        self.session_id.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    fn set_sid(&self, session_id: String) {
        *self.session_id.lock().unwrap_or_else(PoisonError::into_inner) = session_id;
    }

    async fn write_message(&self, message: &Value) -> Result<(), String> {
        let mut line = message.to_string();
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Could not write to the agent: {e}"))
    }

    /// Send a request and await its response (no timeout — callers wrap).
    async fn call(&self, message: Value, id: i64) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap_or_else(PoisonError::into_inner).insert(id, tx);
        self.write_message(&message).await?;
        rx.await
            .unwrap_or_else(|_| Err("The agent ended before responding.".to_owned()))
    }

    async fn call_with_timeout(
        &self,
        message: Value,
        id: i64,
        timeout: Duration,
    ) -> Result<Value, String> {
        tokio::time::timeout(timeout, self.call(message, id))
            .await
            .unwrap_or_else(|_| {
                self.pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&id);
                Err("The agent did not respond in time.".to_owned())
            })
    }

    fn shutdown(&self) {
        for (_, tx) in self.pending.lock().unwrap_or_else(PoisonError::into_inner).drain() {
            let _ = tx.send(Err("Session closed.".to_owned()));
        }
        if let Some(mut child) = self.child.lock().unwrap_or_else(PoisonError::into_inner).take() {
            let _ = child.start_kill();
        }
    }
}

/// Run one turn over ACP, creating or reusing the tab's session.
pub async fn start_turn(
    app: AppHandle,
    sessions: &AcpSessions,
    tab_id: &str,
    provider_id: &str,
    request: TurnRequest,
    mcp_servers: Vec<acp::McpServer>,
) -> Result<(), AcpStartError> {
    let spec = SessionSpec {
        project_path: request.project_path.clone(),
        model: request.model.clone(),
        effort: request.effort.clone(),
        mcp_servers,
    };
    let session = ensure_session(&app, sessions, tab_id, provider_id, &spec).await?;

    if session.turn_active.swap(true, Ordering::SeqCst) {
        return Err(AcpStartError::Failed(
            "A turn is already running in this tab.".to_owned(),
        ));
    }
    session.bypass.store(
        request.permission == agent_core::Permission::Bypass,
        Ordering::SeqCst,
    );
    session
        .plan_mode
        .store(request.mode == agent_core::Mode::Plan, Ordering::SeqCst);

    apply_mode(&session, provider_id, request.mode).await;

    let id = session.request_id();
    let prompt = acp::prompt_request_for_provider(id, &session.sid(), provider_id, &request);
    *session.current_turn.lock().unwrap_or_else(PoisonError::into_inner) = Some(id);

    let app_for_task = app.clone();
    let tab = tab_id.to_owned();
    let session_for_task = Arc::clone(&session);
    tauri::async_runtime::spawn(async move {
        let result = session_for_task.call(prompt, id).await;
        session_for_task.turn_active.store(false, Ordering::SeqCst);
        let mut current = session_for_task.current_turn.lock().unwrap_or_else(PoisonError::into_inner);
        if *current == Some(id) {
            *current = None;
        }
        drop(current);
        runner::emit(&app_for_task, &tab, &acp::completion_from_prompt_result(&result));
    });

    Ok(())
}

/// Ask the agent to switch to the mode's native session mode, if any.
/// Best-effort: an agent that rejects the mode still runs the turn (the
/// prompt preamble covers non-native modes).
async fn apply_mode(session: &Arc<AcpSession>, provider_id: &str, mode: agent_core::Mode) {
    let Some(mode_id) = acp::native_mode_id(provider_id, mode) else {
        return;
    };
    let id = session.request_id();
    let message = acp::set_mode_request(id, &session.sid(), mode_id);
    let _ = session.call_with_timeout(message, id, SET_MODE_TIMEOUT).await;
}

/// How long a cancelled turn may take to acknowledge before the
/// watchdog force-resolves it (so the tab can never stay stuck busy).
const CANCEL_GRACE: Duration = Duration::from_secs(8);

/// Cancel the in-flight turn: answer pending permission requests with
/// `cancelled`, send `session/cancel`, then guarantee the turn resolves
/// even if the agent never responds.
pub async fn cancel_turn(sessions: &AcpSessions, tab_id: &str) {
    let Some(session) = sessions.get(tab_id) else { return };
    let pending: Vec<i64> = session.pending_permissions.lock().unwrap_or_else(PoisonError::into_inner).drain(..).collect();
    for id in pending {
        let _ = session.write_message(&acp::permission_cancelled_response(id)).await;
    }
    let _ = session
        .write_message(&acp::cancel_notification(&session.sid()))
        .await;

    // Watchdog: if the cancelled prompt's response never arrives, fail
    // its pending call so `turn_active` clears and the tab stays usable.
    let cancelled_turn = *session.current_turn.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(turn_id) = cancelled_turn {
        let session = Arc::clone(&session);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(CANCEL_GRACE).await;
            if *session.current_turn.lock().unwrap_or_else(PoisonError::into_inner) != Some(turn_id) {
                return; // resolved normally in the meantime
            }
            if let Some(tx) = session.pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&turn_id) {
                let _ = tx.send(Err("Cancelled.".to_owned()));
            }
        });
    }
}

/// Deliver the user's answer to a pending permission request.
pub async fn respond_permission(
    sessions: &AcpSessions,
    tab_id: &str,
    request_id: &str,
    option_id: &str,
) -> Result<(), String> {
    let session = sessions
        .get(tab_id)
        .ok_or_else(|| "No active agent session for this tab.".to_owned())?;
    let id: i64 = request_id
        .parse()
        .map_err(|_| format!("Invalid permission request id: {request_id}"))?;
    session.pending_permissions.lock().unwrap_or_else(PoisonError::into_inner).retain(|p| *p != id);
    session
        .write_message(&acp::permission_selected_response(id, option_id))
        .await
}

/// Start (or reuse) a tab's session without running a turn — called on
/// app start and whenever provider/model changes, so the handshake cost
/// is paid in the background instead of on the user's first message.
pub async fn warm(
    app: AppHandle,
    sessions: &AcpSessions,
    tab_id: &str,
    provider_id: &str,
    spec: &SessionSpec,
) {
    let _ = ensure_session(&app, sessions, tab_id, provider_id, spec).await;
}

/// Everything that decides WHICH agent process a tab talks to. Grouped
/// because it travels together through every entry point, and because
/// any difference here means the session must be respawned.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSpec {
    pub project_path: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Servers Mota hands the agent at session creation.
    #[serde(default)]
    pub mcp_servers: Vec<acp::McpServer>,
}

async fn ensure_session(
    app: &AppHandle,
    sessions: &AcpSessions,
    tab_id: &str,
    provider_id: &str,
    spec: &SessionSpec,
) -> Result<Arc<AcpSession>, AcpStartError> {
    let SessionSpec { project_path, model, effort, mcp_servers } = spec;
    let (model, effort) = (model.clone(), effort.clone());

    if let Some(existing) = sessions.get(tab_id) {
        if existing.provider_id == provider_id
            && existing.model == model
            && existing.effort == effort
            && existing.mcp_servers == *mcp_servers
        {
            return Ok(existing);
        }
        // Provider, model, effort or tools switched: start over. Servers
        // are fixed when the session is created, so a changed list is
        // only real once the agent has been handed it.
        sessions.end_session(tab_id);
    }

    let (child, install_hint) =
        spawn_agent(provider_id, project_path, model.as_deref(), effort.as_deref())?;
    let mut child = child;
    let stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");

    let session = Arc::new(AcpSession {
        provider_id: provider_id.to_owned(),
        model,
        effort,
        mcp_servers: mcp_servers.clone(),
        session_id: Mutex::new(String::new()),
        child: Mutex::new(Some(child)),
        stdin: tokio::sync::Mutex::new(stdin),
        next_id: AtomicI64::new(0),
        pending: Mutex::new(HashMap::new()),
        pending_permissions: Mutex::new(Vec::new()),
        current_turn: Mutex::new(None),
        bypass: AtomicBool::new(false),
        plan_mode: AtomicBool::new(false),
        turn_active: AtomicBool::new(false),
    });

    spawn_reader(app.clone(), tab_id.to_owned(), Arc::clone(&session), stdout);

    let init_id = session.request_id();
    session
        .call_with_timeout(acp::initialize_request(init_id), init_id, HANDSHAKE_TIMEOUT)
        .await
        .map_err(|e| {
            session.shutdown();
            AcpStartError::Unavailable(format!("{e} (install with: {install_hint})"))
        })?;

    let new_id = session.request_id();
    let new_result = session
        .call_with_timeout(
            acp::session_new_request(new_id, project_path, mcp_servers),
            new_id,
            HANDSHAKE_TIMEOUT,
        )
        .await
        .map_err(|e| {
            session.shutdown();
            AcpStartError::Failed(format!(
                "Could not start an agent session: {e}. If this is an authentication \
                 problem, sign in to the {provider_id} CLI in a terminal first."
            ))
        })?;

    let session_id = new_result
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            session.shutdown();
            AcpStartError::Failed("The agent returned no session id.".to_owned())
        })?
        .to_owned();

    session.set_sid(session_id);
    sessions
        .0
        .lock()
        .unwrap()
        .insert(tab_id.to_owned(), Arc::clone(&session));
    Ok(session)
}

const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const LOAD_TIMEOUT: Duration = Duration::from_secs(180); // replays the whole conversation

/// The agent's own saved sessions for this project (native history).
pub async fn list_native_sessions(
    app: AppHandle,
    sessions: &AcpSessions,
    tab_id: &str,
    provider_id: &str,
    spec: &SessionSpec,
) -> Result<Value, String> {
    let session = ensure_session(&app, sessions, tab_id, provider_id, spec)
        .await
        .map_err(|e| match e {
            AcpStartError::Unavailable(m) | AcpStartError::Failed(m) => m,
        })?;
    let id = session.request_id();
    let result = session
        .call_with_timeout(
            acp::session_list_request(id, &spec.project_path),
            id,
            LIST_TIMEOUT,
        )
        .await?;
    Ok(result.get("sessions").cloned().unwrap_or(Value::Array(vec![])))
}

/// Truly resume one of the agent's saved sessions: the conversation is
/// replayed through the event stream, and the agent continues WITH that
/// context in memory.
pub async fn load_native_session(
    app: AppHandle,
    sessions: &AcpSessions,
    tab_id: &str,
    provider_id: &str,
    spec: &SessionSpec,
    session_id: &str,
) -> Result<(), String> {
    // Never load over an unfinished turn: replacing the session id
    // mid-flight can orphan the pending prompt and wedge the tab.
    if let Some(existing) = sessions.get(tab_id) {
        if existing.turn_active.load(Ordering::SeqCst) {
            return Err(
                "The previous turn is still finishing — wait a moment (or stop it) and try again."
                    .to_owned(),
            );
        }
    }
    let session = ensure_session(&app, sessions, tab_id, provider_id, spec)
        .await
        .map_err(|e| match e {
            AcpStartError::Unavailable(m) | AcpStartError::Failed(m) => m,
        })?;
    let id = session.request_id();
    session
        .call_with_timeout(
            acp::session_load_request(id, session_id, &spec.project_path, &spec.mcp_servers),
            id,
            LOAD_TIMEOUT,
        )
        .await?;
    session.set_sid(session_id.to_owned());
    Ok(())
}

/// Try each launch candidate in order (global binary first, then npx);
/// return the first child that spawns, with the install hint for errors.
/// Launch a provider's ACP agent. `pub(crate)` because the connection
/// probe launches one too, and how an agent starts must be described in
/// exactly one place.
pub(crate) fn spawn_agent(
    provider_id: &str,
    project_path: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<(Child, &'static str), AcpStartError> {
    let candidates = acp::agent_commands(provider_id);
    let install_hint = candidates
        .first()
        .map(|c| c.install_hint)
        .ok_or_else(|| {
            AcpStartError::Unavailable(format!("No ACP agent known for {provider_id}"))
        })?;

    let mut last_error: Option<std::io::Error> = None;
    for candidate in &candidates {
        // Only try candidates that actually resolve on PATH, so the
        // install hint (not a raw spawn error) reaches the user when
        // nothing is installed. The lookup is cached — no process spawn.
        if runner::resolve_program(&candidate.program).is_none() {
            continue;
        }
        let mut command = runner::os_command(&candidate.program, &candidate.args);
        command
            .current_dir(project_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        for (key, value) in acp::agent_env(provider_id, model, effort) {
            command.env(key, value);
        }
        match command.spawn() {
            Ok(child) => return Ok((child, install_hint)),
            Err(e) => last_error = Some(e),
        }
    }
    let detail = last_error
        .map(|e| e.to_string())
        .unwrap_or_else(|| "no launch candidate found on PATH".to_owned());
    Err(AcpStartError::Unavailable(format!(
        "{detail} (install with: {install_hint})"
    )))
}

fn spawn_reader(
    app: AppHandle,
    tab_id: String,
    session: Arc<AcpSession>,
    stdout: tokio::process::ChildStdout,
) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            handle_line(&app, &tab_id, &session, &line).await;
        }
        // Agent process ended.
        if session.turn_active.swap(false, Ordering::SeqCst) {
            runner::emit(
                &app,
                &tab_id,
                &AgentEvent::TurnCompleted {
                    result: Some("The agent process ended unexpectedly.".to_owned()),
                    provider_session_id: None,
                    is_error: true,
                },
            );
        }
        session.shutdown();
    });
}

async fn handle_line(app: &AppHandle, tab_id: &str, session: &Arc<AcpSession>, line: &str) {
    match acp::parse_incoming(line) {
        Some(acp::Incoming::Response { id, result }) => {
            if let Some(tx) = session.pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&id) {
                let _ = tx.send(result);
            }
        }
        Some(acp::Incoming::PermissionRequest {
            id,
            title,
            options,
            plan_markdown,
            plan_file_path,
        }) => {
            // Bypass auto-approves ordinary tool requests — but NEVER a
            // plan approval, and nothing at all while in plan mode.
            let may_auto_approve = session.bypass.load(Ordering::SeqCst)
                && !session.plan_mode.load(Ordering::SeqCst)
                && !acp::is_plan_approval(&title, &options);
            if may_auto_approve {
                if let Some(choice) = acp::bypass_choice(&options) {
                    let response = acp::permission_selected_response(id, &choice.option_id);
                    let _ = session.write_message(&response).await;
                    return;
                }
            }
            session.pending_permissions.lock().unwrap_or_else(PoisonError::into_inner).push(id);
            runner::emit(
                app,
                tab_id,
                &AgentEvent::PermissionRequested {
                    request_id: id.to_string(),
                    title,
                    options,
                    plan_markdown,
                    plan_file_path,
                },
            );
        }
        Some(acp::Incoming::Updates(events)) => {
            for event in events {
                runner::emit(app, tab_id, &event);
            }
        }
        Some(acp::Incoming::UnsupportedRequest { id, method }) => {
            let _ = session
                .write_message(&acp::method_not_found_response(id, &method))
                .await;
        }
        _ => {}
    }
}
