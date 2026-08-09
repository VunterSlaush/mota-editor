//! ACP session manager — persistent Agent Client Protocol sessions, one
//! per tab. Owns the agent subprocess and the wire; all protocol logic
//! (message shapes, classification, translation) lives in
//! `agent_core::acp`, which keeps this file mechanical: spawn, route,
//! respond.

use std::collections::{HashMap, VecDeque};
use std::io::Write as _;
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
use tauri::{AppHandle, Manager};
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

/// A session id worth trying to restore after its process died.
struct RecoveredSession {
    provider_id: String,
    session_id: String,
}

#[derive(Default)]
pub struct AcpSessions {
    map: Mutex<HashMap<String, Arc<AcpSession>>>,
    /// Last known agent-side session per tab, for crash recovery: when
    /// the process dies unexpectedly, the next turn tries `session/load`
    /// on a fresh agent instead of silently starting a blank context.
    /// Cleared by `end_session` — the user asked for a reset there.
    recovery: Mutex<HashMap<String, RecoveredSession>>,
    /// Per-tab boot serialization. Two callers arriving while no session
    /// exists (warm-up racing the first prompt, or the History panel
    /// opening mid-boot) must share ONE boot: each adapter process is a
    /// ~100-300MB Node runtime, and a parallel spare helps nobody.
    /// Entries live as long as the tab; a handful of small Arcs.
    booting: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

pub struct AcpSession {
    provider_id: String,
    /// The project folder — the confinement root for the agent's
    /// client-fs requests.
    project_path: String,
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
    /// In-flight `elicitation/create` ids — questions awaiting an answer.
    /// Separate from permissions: the two are cancelled with different
    /// response shapes.
    pending_questions: Mutex<Vec<i64>>,
    /// Request id of the in-flight `session/prompt`, for the cancel
    /// watchdog: a cancelled turn whose response never arrives must not
    /// leave the tab stuck busy forever.
    current_turn: Mutex<Option<i64>>,
    bypass: AtomicBool,
    /// True while the current turn runs in plan mode — auto-approval is
    /// fully disabled then: approving the plan is the user's call.
    plan_mode: AtomicBool,
    turn_active: AtomicBool,
    /// Set once the agent process is gone (crashed, killed, shut down).
    /// A dead session must never be handed out again — writes to it can
    /// only fail or hang.
    dead: AtomicBool,
    /// True while a crash-recovery `session/load` replays: its
    /// `session/update` stream restores the AGENT's memory, not the
    /// chat (which never lost the conversation), so updates are muted.
    replaying: AtomicBool,
    /// What the agent advertised at `initialize` — gates optional calls
    /// (`session/list`, `session/load`) instead of assuming support.
    caps: Mutex<acp::AgentCaps>,
    /// Mode ids `session/set_mode` may name, per `session/new`. Empty
    /// means the agent reported none — requests are then sent untested.
    available_modes: Mutex<Vec<String>>,
    /// The agent's most recent stderr lines. Diagnostics live here: a
    /// handshake timeout with the real complaint attached beats "did not
    /// respond in time" every time.
    stderr_tail: Mutex<VecDeque<String>>,
    /// Client-owned terminals serving the agent's `terminal/*` requests.
    terminals: crate::terminal::TerminalManager,
}

/// Cap on the retained stderr ring — enough to carry a stack trace,
/// small enough to never matter.
const STDERR_TAIL_LINES: usize = 200;

impl AcpSessions {
    fn get(&self, tab_id: &str) -> Option<Arc<AcpSession>> {
        self.map.lock().unwrap_or_else(PoisonError::into_inner).get(tab_id).cloned()
    }

    pub fn end_session(&self, tab_id: &str) {
        if let Some(session) = self.map.lock().unwrap_or_else(PoisonError::into_inner).remove(tab_id) {
            session.shutdown();
        }
        // An intentional reset must not resurrect the old context later.
        self.recovery.lock().unwrap_or_else(PoisonError::into_inner).remove(tab_id);
    }

    /// Kill the tab's agent process but KEEP its conversation restorable.
    /// A reconfigure (model/effort/servers switch forces a respawn) is
    /// not a reset: the respawned agent should resume the conversation,
    /// not greet the user with amnesia.
    fn retire_session(&self, tab_id: &str) {
        if let Some(session) =
            self.map.lock().unwrap_or_else(PoisonError::into_inner).remove(tab_id)
        {
            session.shutdown();
        }
    }

    /// App exit: kill every agent subprocess deliberately rather than
    /// hoping `kill_on_drop` still runs.
    pub fn shutdown_all(&self) {
        for (_, session) in self.map.lock().unwrap_or_else(PoisonError::into_inner).drain() {
            session.shutdown();
        }
    }

    /// Remember the tab's live agent session for crash recovery.
    fn record_recovery(&self, tab_id: &str, provider_id: &str, session_id: &str) {
        self.recovery.lock().unwrap_or_else(PoisonError::into_inner).insert(
            tab_id.to_owned(),
            RecoveredSession {
                provider_id: provider_id.to_owned(),
                session_id: session_id.to_owned(),
            },
        );
    }

    /// The session id to try restoring for this tab+provider, if any.
    fn recoverable_session(&self, tab_id: &str, provider_id: &str) -> Option<String> {
        let recovery = self.recovery.lock().unwrap_or_else(PoisonError::into_inner);
        recovery
            .get(tab_id)
            .filter(|r| r.provider_id == provider_id)
            .map(|r| r.session_id.clone())
    }

    /// The tab's boot lock. Holding it while creating a session is what
    /// coalesces concurrent boots; awaiting it is how a reader waits for
    /// an in-flight boot instead of concluding "no session".
    fn boot_lock(&self, tab_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(
            self.booting
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry(tab_id.to_owned())
                .or_default(),
        )
    }

    /// Evict a session only if the map still holds THIS one — a respawn
    /// may already have replaced it under the same tab id.
    fn evict(&self, tab_id: &str, session: &Arc<AcpSession>) {
        let mut map = self.map.lock().unwrap_or_else(PoisonError::into_inner);
        if map.get(tab_id).is_some_and(|s| Arc::ptr_eq(s, session)) {
            map.remove(tab_id);
        }
    }
}

impl AcpSession {
    fn request_id(&self) -> i64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    fn caps(&self) -> acp::AgentCaps {
        self.caps.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// The agent's recent stderr as one block, or empty when silent.
    fn stderr_tail_text(&self) -> String {
        let tail = self.stderr_tail.lock().unwrap_or_else(PoisonError::into_inner);
        tail.iter().cloned().collect::<Vec<_>>().join("\n")
    }

    /// Append the agent's stderr to an error message, when there is any
    /// — the difference between "timed out" and knowing why.
    fn with_stderr(&self, message: String) -> String {
        let tail = self.stderr_tail_text();
        if tail.is_empty() {
            message
        } else {
            format!("{message}\n--- agent stderr ---\n{tail}")
        }
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
        self.dead.store(true, Ordering::SeqCst);
        for (_, tx) in self.pending.lock().unwrap_or_else(PoisonError::into_inner).drain() {
            let _ = tx.send(Err("Session closed.".to_owned()));
        }
        // Commands the agent started must not outlive it.
        self.terminals.kill_all();
        if let Some(mut child) = self.child.lock().unwrap_or_else(PoisonError::into_inner).take() {
            let _ = child.start_kill();
        }
    }
}

/// Run one turn over ACP, creating or reusing the tab's session.
///
/// `cancelled` is the stop button's reach into the startup window: the
/// session handshake below can take seconds, and a stop clicked during
/// it must prevent the prompt from ever being sent — not just cancel a
/// turn the agent already has.
pub async fn start_turn(
    app: AppHandle,
    sessions: &AcpSessions,
    tab_id: &str,
    provider_id: &str,
    request: TurnRequest,
    mcp_servers: Vec<acp::McpServer>,
    cancelled: Arc<AtomicBool>,
) -> Result<(), AcpStartError> {
    let spec = SessionSpec {
        project_path: request.project_path.clone(),
        model: request.model.clone(),
        effort: request.effort.clone(),
        mcp_servers,
    };
    let session = ensure_session(&app, sessions, tab_id, provider_id, &spec).await?;

    if cancelled.load(Ordering::SeqCst) {
        // The now-warm session stays registered for the next turn.
        clear_running_turn(&app, tab_id);
        return Ok(());
    }

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

    // Last look before the point of no return: once the prompt is
    // written, stopping is the agent's cooperation (`session/cancel`);
    // before it, stopping is simply not sending it.
    if cancelled.load(Ordering::SeqCst) {
        session.turn_active.store(false, Ordering::SeqCst);
        clear_running_turn(&app, tab_id);
        return Ok(());
    }

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
        clear_running_turn(&app_for_task, &tab);
        // A stop clicked mid-turn resolves this call one way or another
        // (agent acknowledges, or the watchdog fails it) — either way the
        // completion is a cancellation, not an error or a success.
        let was_cancelled = cancelled.load(Ordering::SeqCst);
        runner::emit(
            &app_for_task,
            &tab,
            &acp::completion_from_prompt_result(&result, was_cancelled),
        );
    });

    Ok(())
}

/// Drop the tab's cancel handle once its turn can no longer be started
/// or is over. No-op when `cancel_turn` already claimed it.
fn clear_running_turn(app: &AppHandle, tab_id: &str) {
    let turns = app.state::<crate::commands::RunningTurns>();
    crate::commands::remove_running_turn(&turns, tab_id);
}

/// Ask the agent to switch to the mode's native session mode, if any.
/// Best-effort: an agent that rejects the mode still runs the turn (the
/// prompt preamble covers non-native modes).
async fn apply_mode(session: &Arc<AcpSession>, provider_id: &str, mode: agent_core::Mode) {
    let Some(mode_id) = acp::native_mode_id(provider_id, mode) else {
        return;
    };
    // Only name modes the agent actually offered; an adapter that renamed
    // its ids gets no bogus request (empty list = agent reported none,
    // send untested as before).
    {
        let available = session.available_modes.lock().unwrap_or_else(PoisonError::into_inner);
        if !available.is_empty() && !available.iter().any(|m| m == mode_id) {
            return;
        }
    }
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
    // Unanswered questions must be released too, or the agent's tool call
    // waits forever on a card the user can no longer answer.
    let questions: Vec<i64> = session.pending_questions.lock().unwrap_or_else(PoisonError::into_inner).drain(..).collect();
    for id in questions {
        let _ = session.write_message(&acp::elicitation_cancelled_response(id)).await;
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

/// Deliver the user's answers to a pending question. An empty map means
/// "skip": the agent is told the user declined rather than the turn being
/// aborted, which is what the built-in tool's Skip does.
pub async fn respond_question(
    sessions: &AcpSessions,
    tab_id: &str,
    request_id: &str,
    answers: HashMap<String, String>,
) -> Result<(), String> {
    let session = sessions
        .get(tab_id)
        .ok_or_else(|| "No active agent session for this tab.".to_owned())?;
    let id: i64 = request_id
        .parse()
        .map_err(|_| format!("Invalid question request id: {request_id}"))?;
    session
        .pending_questions
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .retain(|p| *p != id);

    if answers.is_empty() {
        return session
            .write_message(&acp::elicitation_declined_response(id))
            .await;
    }
    // Sorted so the payload is deterministic (question_0 before _1).
    let mut pairs: Vec<(String, String)> = answers.into_iter().collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    session
        .write_message(&acp::elicitation_accept_response(id, &pairs))
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

    // One boot per tab at a time: a second caller (the first prompt or
    // the History panel racing the warm-up) waits here and then finds
    // the finished session in the map, instead of spawning a duplicate
    // adapter process in parallel.
    let boot_lock = sessions.boot_lock(tab_id);
    let _booting = boot_lock.lock().await;

    if let Some(existing) = sessions.get(tab_id) {
        let matches = existing.provider_id == provider_id
            && existing.model == model
            && existing.effort == effort
            && existing.mcp_servers == *mcp_servers;
        // A dead session (agent crashed or was killed) must be respawned
        // even when the spec matches — reusing it can only fail or hang.
        if matches && !existing.dead.load(Ordering::SeqCst) {
            return Ok(existing);
        }
        // Provider, model, effort or tools switched: start over. Servers
        // are fixed when the session is created, so a changed list is
        // only real once the agent has been handed it. But start over
        // does NOT mean start from zero — remember the live conversation
        // so the recovery path below resumes it into the fresh agent.
        // (A dead session keeps whatever recovery entry it recorded at
        // creation; a changed provider is filtered out by
        // `recoverable_session`, which matches on provider id.)
        if !existing.dead.load(Ordering::SeqCst) {
            let sid = existing.sid();
            if !sid.is_empty() {
                sessions.record_recovery(tab_id, &existing.provider_id, &sid);
            }
        }
        sessions.retire_session(tab_id);
    }

    let session = boot_agent(app, tab_id, provider_id, spec, true).await.inspect_err(|_| {
        emit_stage(app, tab_id, "ready"); // never leave the chip stuck
    })?;

    // Recovery: when the previous process died — or was retired by a
    // model/effort reconfigure — with a conversation in it, try to reload
    // that session into the fresh agent instead of silently starting a
    // blank context (the tab still shows the chat — the agent should
    // still remember it).
    if let Some(old_id) = sessions.recoverable_session(tab_id, provider_id) {
        let caps = session.caps();
        if caps.session_resume || caps.load_session {
            emit_stage(app, tab_id, "recovering");
            // `session/resume` restores the agent's memory without the
            // whole-conversation replay — which recovery mutes anyway
            // (the transcript never left the screen). Cheap path first,
            // full reload as the fallback.
            let restored = if try_resume(&session, &old_id, spec).await {
                Ok(())
            } else if caps.load_session {
                let id = session.request_id();
                // The replayed conversation must not flood the chat — the
                // transcript is already on screen; only the agent's memory
                // is being restored.
                session.replaying.store(true, Ordering::SeqCst);
                let loaded = session
                    .call_with_timeout(
                        acp::session_load_request(id, &old_id, project_path, mcp_servers),
                        id,
                        LOAD_TIMEOUT,
                    )
                    .await;
                session.replaying.store(false, Ordering::SeqCst);
                loaded.map(|_| ())
            } else {
                Err("the agent could not resume it".to_owned())
            };
            match restored {
                Ok(()) => {
                    adopt_session(app, tab_id, &session, old_id.clone());
                    sessions
                        .map
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .insert(tab_id.to_owned(), Arc::clone(&session));
                    emit_stage(app, tab_id, "ready");
                    return Ok(session);
                }
                Err(e) => {
                    // Fall through to a fresh session — but say so, or the
                    // agent's sudden amnesia looks like a model failure.
                    runner::emit(
                        app,
                        tab_id,
                        &AgentEvent::ErrorOccurred {
                            message: format!(
                                "The previous conversation could not be restored ({e}); \
                                 the agent starts fresh."
                            ),
                            context: Some("session-not-restored".to_owned()),
                            stderr_tail: None,
                        },
                    );
                }
            }
        }
    }

    emit_stage(app, tab_id, "creating");
    let new_id = session.request_id();
    let new_result = session
        .call_with_timeout(
            acp::session_new_request(new_id, project_path, mcp_servers),
            new_id,
            HANDSHAKE_TIMEOUT,
        )
        .await
        .map_err(|e| {
            let detail = session.with_stderr(format!(
                "Could not start an agent session: {e}. If this is an authentication \
                 problem, sign in to the {provider_id} CLI in a terminal first."
            ));
            session.shutdown();
            emit_stage(app, tab_id, "ready");
            AcpStartError::Failed(detail)
        })?;

    let (session_id, modes) = acp::parse_session_new_result(&new_result);
    let Some(session_id) = session_id else {
        session.shutdown();
        emit_stage(app, tab_id, "ready");
        return Err(AcpStartError::Failed("The agent returned no session id.".to_owned()));
    };

    sessions.record_recovery(tab_id, provider_id, &session_id);
    adopt_session(app, tab_id, &session, session_id);
    // Kept for validating `session/set_mode` requests — NOT emitted as a
    // ModeChanged: the user's picker choice is applied right after this
    // (apply_mode), and stomping it with the agent's default would be
    // the exact desync this field exists to prevent. Only genuine
    // `current_mode_update` notifications move the picker.
    *session.available_modes.lock().unwrap_or_else(PoisonError::into_inner) =
        modes.available;
    sessions
        .map
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(tab_id.to_owned(), Arc::clone(&session));
    emit_stage(app, tab_id, "ready");
    Ok(session)
}

/// Spawn the provider's ACP adapter and complete `initialize` — the
/// session-agnostic half of a session. `session/new` is deliberately
/// not part of this: it can boot the provider's full CLI (tens of
/// seconds on slow adapters), which the settings probe never needs.
///
/// `emit_stages` gates the startup progress events: real sessions want
/// them; the throwaway settings probe must not flash the UI with
/// stages for a process the user never asked to watch.
async fn boot_agent(
    app: &AppHandle,
    tab_id: &str,
    provider_id: &str,
    spec: &SessionSpec,
    emit_stages: bool,
) -> Result<Arc<AcpSession>, AcpStartError> {
    let SessionSpec { project_path, model, effort, mcp_servers } = spec;
    let spawned =
        spawn_agent(provider_id, project_path, model.as_deref(), effort.as_deref())?;
    let SpawnedAgent { mut child, install_hint, via_npx } = spawned;
    let stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    if emit_stages {
        emit_stage(app, tab_id, if via_npx { "installing" } else { "booting" });
    }

    let session = Arc::new(AcpSession {
        provider_id: provider_id.to_owned(),
        project_path: project_path.clone(),
        model: model.clone(),
        effort: effort.clone(),
        mcp_servers: mcp_servers.clone(),
        session_id: Mutex::new(String::new()),
        child: Mutex::new(Some(child)),
        stdin: tokio::sync::Mutex::new(stdin),
        next_id: AtomicI64::new(0),
        pending: Mutex::new(HashMap::new()),
        pending_permissions: Mutex::new(Vec::new()),
        pending_questions: Mutex::new(Vec::new()),
        current_turn: Mutex::new(None),
        bypass: AtomicBool::new(false),
        plan_mode: AtomicBool::new(false),
        turn_active: AtomicBool::new(false),
        dead: AtomicBool::new(false),
        replaying: AtomicBool::new(false),
        caps: Mutex::new(acp::AgentCaps::default()),
        available_modes: Mutex::new(Vec::new()),
        stderr_tail: Mutex::new(VecDeque::new()),
        terminals: crate::terminal::TerminalManager::default(),
    });

    spawn_reader(app.clone(), tab_id.to_owned(), Arc::clone(&session), stdout);
    spawn_stderr_reader(app, provider_id, Arc::clone(&session), stderr);

    let init_id = session.request_id();
    let init_result = session
        .call_with_timeout(acp::initialize_request(init_id), init_id, HANDSHAKE_TIMEOUT)
        .await
        .map_err(|e| {
            let detail = session.with_stderr(format!("{e} (install with: {install_hint})"));
            session.shutdown();
            AcpStartError::Unavailable(detail)
        })?;
    match acp::parse_initialize_result(&init_result) {
        Ok(caps) => {
            *session.caps.lock().unwrap_or_else(PoisonError::into_inner) = caps;
        }
        Err(message) => {
            session.shutdown();
            return Err(AcpStartError::Failed(message));
        }
    }
    Ok(session)
}

/// One startup-stage breadcrumb for the UI's progress chip.
fn emit_stage(app: &AppHandle, tab_id: &str, stage: &str) {
    runner::emit(app, tab_id, &AgentEvent::SessionStage { stage: stage.to_owned() });
}

/// Take ownership of the agent's session id AND tell the frontend.
///
/// Both halves, always — a sid held only in this process is invisible to
/// everything that outlives it. The frontend persists what we emit here
/// (`providerSessions`, and the transcript's `providerSessionId`), which
/// is what lets a restarted app resume the conversation and what lets
/// Insights join a transcript to the vendor's own billing log. Setting
/// the sid without emitting is the bug this function exists to prevent.
fn adopt_session(app: &AppHandle, tab_id: &str, session: &AcpSession, session_id: String) {
    session.set_sid(session_id.clone());
    runner::emit(app, tab_id, &AgentEvent::SessionStarted { provider_session_id: session_id });
}

/// Drain the agent's stderr forever: every line goes into the session's
/// ring (attached to errors) and, best-effort, a per-provider log file.
/// Draining is not optional — a full pipe blocks the agent mid-write.
fn spawn_stderr_reader(
    app: &AppHandle,
    provider_id: &str,
    session: Arc<AcpSession>,
    stderr: tokio::process::ChildStderr,
) {
    let log_path = app
        .path()
        .app_log_dir()
        .ok()
        .map(|dir| dir.join(format!("acp-{provider_id}.log")));
    tauri::async_runtime::spawn(async move {
        let mut log_file = log_path.and_then(|path| {
            std::fs::create_dir_all(path.parent()?).ok()?;
            std::fs::OpenOptions::new().create(true).append(true).open(path).ok()
        });
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(file) = log_file.as_mut() {
                let _ = writeln!(file, "{line}");
            }
            let mut tail = session.stderr_tail.lock().unwrap_or_else(PoisonError::into_inner);
            if tail.len() >= STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    });
}

const LIST_TIMEOUT: Duration = Duration::from_secs(30);
const LOAD_TIMEOUT: Duration = Duration::from_secs(180); // replays the whole conversation
const RESUME_TIMEOUT: Duration = Duration::from_secs(30); // attaches without a replay

/// The agent's own saved sessions for this project (native history).
///
/// Local-first history: the panel paints from the local transcript
/// store, and this native listing only ever asks a session that is
/// ALREADY live — `Null` means "no live session, we didn't ask". No
/// process may be booted here: a throwaway adapter is tens of seconds
/// of boot and a ~100-300MB Node runtime, all to answer a listing the
/// local store already covers.
pub async fn list_native_sessions(
    sessions: &AcpSessions,
    tab_id: &str,
    provider_id: &str,
    spec: &SessionSpec,
) -> Result<Value, String> {
    // A boot already in flight (warm-up racing the panel) is worth
    // waiting for: the session it produces can answer, while asking
    // right now would miss it and report no history.
    drop(sessions.boot_lock(tab_id).lock().await);
    if let Some(existing) = sessions.get(tab_id) {
        // Reused whatever its model/effort spec — killing a warm session
        // just to ask it a question was this panel's "sometimes empty"
        // bug, and `session/list` only needs the cwd anyway.
        if existing.provider_id == provider_id && !existing.dead.load(Ordering::SeqCst) {
            return list_sessions_via(&existing, &spec.project_path).await;
        }
    }
    Ok(Value::Null)
}

async fn list_sessions_via(
    session: &Arc<AcpSession>,
    project_path: &str,
) -> Result<Value, String> {
    // `session/list` is an extension — calling it unadvertised earns a
    // -32601 and a confusing error row in the History panel.
    if !session.caps().session_list {
        return Ok(Value::Array(vec![]));
    }
    let id = session.request_id();
    let result = session
        .call_with_timeout(acp::session_list_request(id, project_path), id, LIST_TIMEOUT)
        .await?;
    Ok(result.get("sessions").cloned().unwrap_or(Value::Array(vec![])))
}

/// Attach the agent to a saved session WITHOUT replaying it
/// (`session/resume`, a draft extension). False when the capability
/// isn't advertised or the agent refused — callers fall back to the
/// full `session/load`.
async fn try_resume(
    session: &Arc<AcpSession>,
    session_id: &str,
    spec: &SessionSpec,
) -> bool {
    if !session.caps().session_resume {
        return false;
    }
    let id = session.request_id();
    session
        .call_with_timeout(
            acp::session_resume_request(id, session_id, &spec.project_path, &spec.mcp_servers),
            id,
            RESUME_TIMEOUT,
        )
        .await
        .is_ok()
}

/// Truly resume one of the agent's saved sessions: the agent continues
/// WITH that context in memory. Returns whether the conversation was
/// REPLAYED through the event stream — `session/resume` skips the
/// replay, so the caller paints from its own transcript copy instead.
pub async fn load_native_session(
    app: AppHandle,
    sessions: &AcpSessions,
    tab_id: &str,
    provider_id: &str,
    spec: &SessionSpec,
    session_id: &str,
    prefer_resume: bool,
) -> Result<bool, String> {
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
    // `prefer_resume` is only set when the caller has a transcript of
    // its own to show — resume skips the replay, so without one the
    // conversation would come back as a blank screen.
    if prefer_resume && try_resume(&session, session_id, spec).await {
        adopt_session(&app, tab_id, &session, session_id.to_owned());
        sessions.record_recovery(tab_id, provider_id, session_id);
        return Ok(false);
    }
    if !session.caps().load_session {
        return Err("This agent cannot resume saved sessions.".to_owned());
    }
    let id = session.request_id();
    session
        .call_with_timeout(
            acp::session_load_request(id, session_id, &spec.project_path, &spec.mcp_servers),
            id,
            LOAD_TIMEOUT,
        )
        .await?;
    adopt_session(&app, tab_id, &session, session_id.to_owned());
    sessions.record_recovery(tab_id, provider_id, session_id);
    Ok(true)
}

/// A freshly launched (not yet initialized) ACP agent process.
struct SpawnedAgent {
    child: Child,
    install_hint: &'static str,
    /// True when the npx fallback launched — the first run may be
    /// downloading the adapter, which is worth telling the user.
    via_npx: bool,
}

/// Try each launch candidate in order (global binary first, then npx);
/// return the first child that spawns, with the install hint for errors.
/// stderr is always piped — the caller must drain it (an undrained pipe
/// eventually blocks the agent mid-write).
fn spawn_agent(
    provider_id: &str,
    project_path: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<SpawnedAgent, AcpStartError> {
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
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in acp::agent_env(provider_id, model, effort) {
            command.env(key, value);
        }
        match command.spawn() {
            Ok(child) => {
                return Ok(SpawnedAgent {
                    child,
                    install_hint,
                    via_npx: candidate.program == "npx",
                })
            }
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

/// One-shot connection check for the settings screen: boot the agent,
/// open (and immediately abandon) a session, report what it advertised.
/// Runs on the same wire code as real sessions — the probe used to be a
/// second hand-rolled JSON-RPC loop, and two implementations of one
/// protocol only ever drift apart. Never registered in the session map;
/// no stage events (nothing the user asked to watch).
pub(crate) async fn probe_handshake(
    app: &AppHandle,
    provider_id: &str,
    project_path: &str,
    timeout: Duration,
) -> Result<acp::AgentCaps, AcpStartError> {
    let spec = SessionSpec {
        project_path: project_path.to_owned(),
        model: None,
        effort: None,
        // No MCP servers: the probe asks "can you work at all?", and a
        // failing server would answer a different question.
        mcp_servers: Vec::new(),
    };
    let tab_id = format!("probe:{provider_id}");
    let session = boot_agent(app, &tab_id, provider_id, &spec, false).await?;

    let id = session.request_id();
    let opened = session
        .call_with_timeout(acp::session_new_request(id, project_path, &[]), id, timeout)
        .await;
    let result = match opened {
        Ok(_) => Ok(session.caps()),
        // Started but refused to open a session — almost always a
        // missing login; the agent's stderr usually says so.
        Err(e) => Err(AcpStartError::Failed(session.with_stderr(e))),
    };
    session.shutdown();
    result
}

/// Serve one `terminal/*` request against the session's terminals.
async fn handle_terminal_request(
    session: &Arc<AcpSession>,
    request: acp::TerminalRequest,
) -> Value {
    use acp::TerminalRequest as T;
    match request {
        T::Create { id, command, args, env, cwd, output_byte_limit } => {
            let cwd = cwd.unwrap_or_else(|| session.project_path.clone());
            match session.terminals.create(&command, &args, &env, &cwd, output_byte_limit)
            {
                Ok(terminal_id) => acp::terminal_create_response(id, &terminal_id),
                Err(message) => acp::internal_error_response(id, &message),
            }
        }
        T::Output { id, terminal_id } => match session.terminals.get(&terminal_id) {
            Some(handle) => {
                let (output, truncated, exit) = handle.output();
                let exit_pair = exit.as_ref().map(|e| (e.code, e.signal.as_deref()));
                acp::terminal_output_response(id, &output, truncated, exit_pair)
            }
            None => acp::internal_error_response(id, &unknown_terminal(&terminal_id)),
        },
        T::WaitForExit { id, terminal_id } => match session.terminals.get(&terminal_id) {
            Some(handle) => {
                let exit = handle.wait_for_exit().await;
                acp::terminal_exit_response(id, exit.code, exit.signal.as_deref())
            }
            None => acp::internal_error_response(id, &unknown_terminal(&terminal_id)),
        },
        T::Kill { id, terminal_id } => match session.terminals.get(&terminal_id) {
            Some(handle) => {
                handle.kill();
                acp::empty_result_response(id)
            }
            None => acp::internal_error_response(id, &unknown_terminal(&terminal_id)),
        },
        T::Release { id, terminal_id } => {
            session.terminals.release(&terminal_id);
            acp::empty_result_response(id)
        }
    }
}

fn unknown_terminal(terminal_id: &str) -> String {
    format!("No such terminal: {terminal_id}")
}

/// Read a terminal's captured output for the UI (polled by the tool-call
/// card that embeds it).
pub fn read_terminal_output(
    sessions: &AcpSessions,
    tab_id: &str,
    terminal_id: &str,
) -> Option<(String, bool, bool)> {
    let session = sessions.get(tab_id)?;
    let handle = session.terminals.get(terminal_id)?;
    let (output, truncated, exit) = handle.output();
    Some((output, truncated, exit.is_some()))
}

/// Resolve an agent-supplied path and require it inside the project.
/// Canonicalizes real paths so `..` and symlinks cannot escape; for a
/// write to a not-yet-existing file the PARENT directory must exist and
/// be inside instead (the spec says create the file, not directories).
fn confine_to_project(
    project_path: &str,
    requested: &str,
    must_exist: bool,
) -> Result<std::path::PathBuf, String> {
    let project = std::fs::canonicalize(project_path)
        .map_err(|e| format!("Project folder unavailable: {e}"))?;
    match std::fs::canonicalize(requested) {
        Ok(file) => {
            if file.starts_with(&project) {
                Ok(file)
            } else {
                Err(format!("Path is outside the project: {requested}"))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !must_exist => {
            let path = std::path::Path::new(requested);
            let parent = path
                .parent()
                .ok_or_else(|| format!("Path has no parent directory: {requested}"))?;
            let file_name = path
                .file_name()
                .ok_or_else(|| format!("Path names no file: {requested}"))?;
            let parent = std::fs::canonicalize(parent)
                .map_err(|e| format!("Parent directory unavailable: {e}"))?;
            if parent.starts_with(&project) {
                Ok(parent.join(file_name))
            } else {
                Err(format!("Path is outside the project: {requested}"))
            }
        }
        Err(e) => Err(format!("Could not resolve {requested}: {e}")),
    }
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
            let tail = session.stderr_tail_text();
            runner::emit(
                &app,
                &tab_id,
                &AgentEvent::ErrorOccurred {
                    message: "The agent process ended unexpectedly. The next message \
                              will restart it and try to restore the conversation."
                        .to_owned(),
                    context: Some("agent-exited".to_owned()),
                    stderr_tail: (!tail.is_empty()).then_some(tail),
                },
            );
            runner::emit(
                &app,
                &tab_id,
                &AgentEvent::TurnCompleted {
                    result: None,
                    provider_session_id: None,
                    is_error: true,
                    stop_reason: None,
                },
            );
        }
        session.shutdown();
        // Evict too: a shut-down session left in the map would be handed
        // to the next caller (history list, next turn) and can only fail
        // or hang them into a timeout.
        app.state::<AcpSessions>().evict(&tab_id, &session);
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
            tool_call_id,
            tool_kind,
        }) => {
            // Bypass auto-approves ordinary tool requests — but NEVER a
            // plan approval, and nothing at all while in plan mode. When
            // the agent offers no allow option, bypass_choice is None and
            // the request falls through to the user.
            let may_auto_approve = session.bypass.load(Ordering::SeqCst)
                && !session.plan_mode.load(Ordering::SeqCst)
                && !acp::is_plan_approval(&title, &options, tool_kind.as_deref());
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
                    tool_call_id,
                },
            );
        }
        Some(acp::Incoming::ElicitationRequest { id, message, questions }) => {
            // Deliberately NOT auto-answered under bypass permissions.
            // Bypass means "don't ask me to approve your actions"; it does
            // not mean "decide for me". Picking an option on the user's
            // behalf would send the agent off on a choice nobody made.
            session
                .pending_questions
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(id);
            runner::emit(
                app,
                tab_id,
                &AgentEvent::QuestionAsked {
                    request_id: id.to_string(),
                    message,
                    questions,
                },
            );
        }
        Some(acp::Incoming::UnsupportedElicitation { id }) => {
            // Declining (not erroring) lets the agent carry on without the
            // answer instead of failing the whole turn.
            let _ = session
                .write_message(&acp::elicitation_declined_response(id))
                .await;
        }
        Some(acp::Incoming::Updates(events)) => {
            // A crash-recovery replay restores agent memory, not the
            // chat — the transcript on screen never went anywhere.
            if session.replaying.load(Ordering::SeqCst) {
                return;
            }
            for event in events {
                runner::emit(app, tab_id, &event);
            }
        }
        // Client fs, spawned off the reader loop (disk must never stall
        // the wire). Paths come from the AGENT and are confined to the
        // project folder — a prompt-injected agent must not turn this
        // into an arbitrary-file read or write.
        Some(acp::Incoming::FsReadRequest { id, path, line, limit }) => {
            let session = Arc::clone(session);
            tauri::async_runtime::spawn(async move {
                let response = match confine_to_project(&session.project_path, &path, true)
                {
                    Ok(file) => match tokio::fs::read_to_string(&file).await {
                        Ok(text) => {
                            acp::fs_read_response(id, &acp::slice_lines(&text, line, limit))
                        }
                        Err(e) => acp::internal_error_response(
                            id,
                            &format!("Could not read {path}: {e}"),
                        ),
                    },
                    Err(message) => acp::internal_error_response(id, &message),
                };
                let _ = session.write_message(&response).await;
            });
        }
        Some(acp::Incoming::Terminal(request)) => {
            let session = Arc::clone(session);
            tauri::async_runtime::spawn(async move {
                let response = handle_terminal_request(&session, request).await;
                let _ = session.write_message(&response).await;
            });
        }
        Some(acp::Incoming::FsWriteRequest { id, path, content }) => {
            let session = Arc::clone(session);
            tauri::async_runtime::spawn(async move {
                let response =
                    match confine_to_project(&session.project_path, &path, false) {
                        Ok(file) => match tokio::fs::write(&file, &content).await {
                            Ok(()) => acp::fs_write_response(id),
                            Err(e) => acp::internal_error_response(
                                id,
                                &format!("Could not write {path}: {e}"),
                            ),
                        },
                        Err(message) => acp::internal_error_response(id, &message),
                    };
                let _ = session.write_message(&response).await;
            });
        }
        Some(acp::Incoming::UnsupportedRequest { id, method }) => {
            let _ = session
                .write_message(&acp::method_not_found_response(id, &method))
                .await;
        }
        _ => {}
    }
}
