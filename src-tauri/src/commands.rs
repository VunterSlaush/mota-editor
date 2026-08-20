//! Tauri command handlers — the controllers of the interface-adapter
//! layer. Thin by design: validate, delegate, return.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use agent_core::{provider_for, AgentEvent, Mode, Permission, TurnRequest};
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
use tokio::process::Child;

use crate::acp_session::{self, AcpSessions, AcpStartError, SessionSpec};
use crate::command_discovery;
use crate::runner;
use crate::workspace_file;

/// In-flight turns by tab id, so they can be cancelled.
#[derive(Default)]
pub struct RunningTurns(pub Mutex<HashMap<String, CancelHandle>>);

/// One in-flight turn's cancellation levers. The flag is the source of
/// truth for "the user asked to stop": it is set synchronously and
/// checked before the prompt is ever sent to the agent, which covers the
/// session-handshake window where there is no session and no child to
/// signal yet. The channel interrupts the headless stream.
pub struct CancelHandle {
    tx: tokio::sync::mpsc::Sender<()>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTurnArgs {
    pub tab_id: String,
    pub provider_id: String,
    pub project_path: String,
    pub prompt: String,
    pub resume_session_id: Option<String>,
    #[serde(default)]
    pub mode: Mode,
    #[serde(default)]
    pub permission: Permission,
    #[serde(default)]
    pub attachments: Vec<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub mcp_servers: Vec<agent_core::acp::McpServer>,
    #[serde(default)]
    pub subtask: Option<agent_core::SubtaskScope>,
}

#[tauri::command]
pub async fn start_turn(
    app: AppHandle,
    turns: State<'_, RunningTurns>,
    acp: State<'_, AcpSessions>,
    args: StartTurnArgs,
) -> Result<(), String> {
    let provider = provider_for(&args.provider_id)
        .ok_or_else(|| format!("Unknown provider: {}", args.provider_id))?;

    let project_path = PathBuf::from(&args.project_path);
    if !project_path.is_dir() {
        return Err(format!("Project folder not found: {}", args.project_path));
    }

    // Register the cancel handle before any slow work (agent spawn,
    // handshake): the stop button is live from the moment the user hits
    // send, and a stop must have something to land on from that moment.
    let (cancel_tx, mut cancel_rx) = tokio::sync::mpsc::channel::<()>(1);
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut running = turns.0.lock().unwrap_or_else(PoisonError::into_inner);
        if running.contains_key(&args.tab_id) {
            return Err("A turn is already running in this tab.".to_owned());
        }
        running.insert(
            args.tab_id.clone(),
            CancelHandle { tx: cancel_tx, cancelled: Arc::clone(&cancelled) },
        );
    }

    let request = TurnRequest {
        prompt: args.prompt,
        project_path: args.project_path,
        resume_session_id: args.resume_session_id,
        mode: args.mode,
        permission: args.permission,
        attachments: args.attachments,
        model: validate_token(args.model, "model")?,
        effort: validate_token(args.effort, "effort")?,
        subtask: args.subtask,
    };

    // Preferred transport: a persistent ACP session (interactive
    // approvals, streaming). Falls back to one-shot headless mode when
    // the provider's ACP agent isn't available on this machine.
    match acp_session::start_turn(
        app.clone(),
        &acp,
        &args.tab_id,
        provider.id(),
        request.clone(),
        args.mcp_servers.clone(),
        Arc::clone(&cancelled),
    )
    .await
    {
        Ok(()) => return Ok(()),
        Err(AcpStartError::Failed(message)) => {
            remove_running_turn(&turns, &args.tab_id);
            return Err(message);
        }
        Err(AcpStartError::Unavailable(reason)) => {
            runner::emit(
                &app,
                &args.tab_id,
                &AgentEvent::ToolUse {
                    name: "info".to_owned(),
                    detail: format!(
                        "Interactive mode unavailable — using basic mode. ({reason})"
                    ),
                },
            );
        }
    }

    // A stop that arrived while ACP was being probed must not fall
    // through into a headless run of the very prompt the user killed.
    if cancelled.load(Ordering::SeqCst) {
        remove_running_turn(&turns, &args.tab_id);
        return Ok(());
    }

    let command = provider.build_command(&request);
    let child: Child = runner::spawn(&command, &project_path).map_err(|e| {
        remove_running_turn(&turns, &args.tab_id);
        spawn_error(provider.id(), &e)
    })?;

    let app_for_task = app.clone();
    let tab_id = args.tab_id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            () = runner::stream_turn(app_for_task.clone(), tab_id.clone(), provider, child) => {}
            _ = cancel_rx.recv() => {
                // Turn cancelled: the child is killed on drop (kill_on_drop).
            }
        }
        let turns = app_for_task.state::<RunningTurns>();
        turns.0.lock().unwrap_or_else(PoisonError::into_inner).remove(&tab_id);
    });

    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WarmSessionArgs {
    pub tab_id: String,
    pub provider_id: String,
    pub project_path: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub mcp_servers: Vec<agent_core::acp::McpServer>,
    #[serde(default)]
    pub subtask: Option<agent_core::SubtaskScope>,
}

impl WarmSessionArgs {
    /// Blank strings arrive from empty pickers; they mean "the provider's
    /// own default", not a model literally called "".
    fn spec(&self) -> Result<SessionSpec, String> {
        Ok(SessionSpec {
            project_path: self.project_path.clone(),
            model: validate_token(self.model.clone(), "model")?,
            effort: validate_token(self.effort.clone(), "effort")?,
            mcp_servers: self.mcp_servers.clone(),
            subtask: self.subtask.clone(),
        })
    }
}

/// Models and efforts are picker values in the UI, but they travel into
/// provider command lines and config strings — restrict them to plain
/// tokens so nothing can smuggle flags or quoting along.
///
/// `/` is allowed because gateway-routed providers name their models
/// `vendor/model`. It introduces no new risk: the value only ever becomes
/// an env-var value or a single argv element, and `runner::os_command`
/// passes an argv vector to an absolute program, never a shell. A leading
/// `-` is a different matter — any CLI this is appended to would read it
/// as a flag rather than the model it claims to be — so that is rejected.
fn validate_token(value: Option<String>, what: &str) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Ok(None);
    }
    let plain = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '/'));
    if plain && !value.starts_with('-') {
        Ok(Some(value))
    } else {
        Err(format!("Invalid {what} name: {value}"))
    }
}

/// Run filesystem work off the main thread so a slow disk (network
/// home dir, antivirus scan, cold cache) can never stall the UI.
pub(crate) async fn run_blocking<T: Send + 'static>(
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| e.to_string())?
}

/// Pre-start a tab's agent session in the background so the first
/// message doesn't pay the handshake cost. Best-effort by design.
#[tauri::command]
pub async fn warm_session(
    app: AppHandle,
    acp: State<'_, AcpSessions>,
    args: WarmSessionArgs,
) -> Result<(), String> {
    if !PathBuf::from(&args.project_path).is_dir() {
        return Ok(());
    }
    acp_session::warm(app, &acp, &args.tab_id, &args.provider_id, &args.spec()?).await;
    Ok(())
}

/// The agent's own saved sessions for this project (native history).
/// Answered only by an already-live session — `null` when there is
/// none, so the History panel never costs an agent boot.
#[tauri::command]
pub async fn list_agent_sessions(
    acp: State<'_, AcpSessions>,
    args: WarmSessionArgs,
) -> Result<serde_json::Value, String> {
    acp_session::list_native_sessions(&acp, &args.tab_id, &args.provider_id, &args.spec()?)
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadSessionArgs {
    #[serde(flatten)]
    pub warm: WarmSessionArgs,
    pub session_id: String,
    /// Prefer `session/resume` (attach without the replay) — set only
    /// when the caller has its own transcript copy to paint from.
    #[serde(default)]
    pub prefer_resume: bool,
}

/// Truly resume one of the agent's saved sessions in this tab. Returns
/// whether the conversation was replayed through the event stream.
#[tauri::command]
pub async fn load_agent_session(
    app: AppHandle,
    acp: State<'_, AcpSessions>,
    args: LoadSessionArgs,
) -> Result<bool, String> {
    acp_session::load_native_session(
        app,
        &acp,
        &args.warm.tab_id,
        &args.warm.provider_id,
        &args.warm.spec()?,
        &args.session_id,
        args.prefer_resume,
    )
    .await
}

/// Read a plan file the agent saved (history stores the path, not the
/// content). The path originates from the AGENT, not the user, so it is
/// confined: markdown only, and only inside the project folder or the
/// user's `.claude` directory (where agents keep plan files) — a
/// prompt-injected agent must not turn this into an arbitrary-file read.
#[tauri::command]
pub async fn read_plan_file(
    app: AppHandle,
    project_path: String,
    path: String,
) -> Result<Option<String>, String> {
    run_blocking(move || {
        if !path.ends_with(".md") {
            return Err("Not a markdown file.".to_owned());
        }
        // Canonicalize both sides so prefix checks compare real paths
        // (resolves `..`, symlinks, and Windows' \\?\ prefix alike).
        let file = match std::fs::canonicalize(&path) {
            Ok(p) => p,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        let mut allowed = Vec::new();
        if let Ok(project) = std::fs::canonicalize(&project_path) {
            allowed.push(project);
        }
        if let Ok(home) = app.path().home_dir() {
            if let Ok(claude_dir) = std::fs::canonicalize(home.join(".claude")) {
                allowed.push(claude_dir);
            }
        }
        if !allowed.iter().any(|root| file.starts_with(root)) {
            return Err("The plan file is outside the project.".to_owned());
        }
        match std::fs::read_to_string(&file) {
            Ok(contents) => Ok(Some(contents)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
}

#[tauri::command]
pub async fn cancel_turn(
    turns: State<'_, RunningTurns>,
    acp: State<'_, AcpSessions>,
    tab_id: String,
) -> Result<(), String> {
    let handle = turns.0.lock().unwrap_or_else(PoisonError::into_inner).remove(&tab_id);
    // Flag first: it is the only lever that works while the session is
    // still handshaking and there is nothing to signal or kill yet.
    if let Some(handle) = &handle {
        handle.cancelled.store(true, Ordering::SeqCst);
    }
    acp_session::cancel_turn(&acp, &tab_id).await;
    if let Some(handle) = handle {
        let _ = handle.tx.send(()).await;
    }
    Ok(())
}

pub(crate) fn remove_running_turn(turns: &RunningTurns, tab_id: &str) {
    turns.0.lock().unwrap_or_else(PoisonError::into_inner).remove(tab_id);
}

#[tauri::command]
pub async fn respond_permission(
    acp: State<'_, AcpSessions>,
    tab_id: String,
    request_id: String,
    option_id: String,
) -> Result<(), String> {
    acp_session::respond_permission(&acp, &tab_id, &request_id, &option_id).await
}

/// The user's answers to an agent question, keyed by form field. An
/// empty map is a deliberate skip, not a missing value.
#[tauri::command]
pub async fn respond_question(
    acp: State<'_, AcpSessions>,
    tab_id: String,
    request_id: String,
    answers: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    acp_session::respond_question(&acp, &tab_id, &request_id, answers).await
}

#[tauri::command]
pub async fn end_session(
    turns: State<'_, RunningTurns>,
    acp: State<'_, AcpSessions>,
    tab_id: String,
) -> Result<(), String> {
    acp.end_session(&tab_id);
    let handle = turns.0.lock().unwrap_or_else(PoisonError::into_inner).remove(&tab_id);
    if let Some(handle) = handle {
        handle.cancelled.store(true, Ordering::SeqCst);
        let _ = handle.tx.send(()).await;
    }
    Ok(())
}

/// A terminal's captured output, for the tool-call card that mirrors it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub output: String,
    pub truncated: bool,
    pub exited: bool,
}

#[tauri::command]
pub async fn get_terminal_output(
    acp: State<'_, AcpSessions>,
    tab_id: String,
    terminal_id: String,
) -> Result<Option<TerminalOutput>, String> {
    Ok(acp_session::read_terminal_output(&acp, &tab_id, &terminal_id).map(
        |(output, truncated, exited)| TerminalOutput { output, truncated, exited },
    ))
}

#[tauri::command]
pub async fn list_custom_commands(
    app: AppHandle,
    project_path: String,
    provider_id: String,
) -> Result<Vec<command_discovery::CustomCommand>, String> {
    run_blocking(move || Ok(command_discovery::discover(&app, &project_path, &provider_id)))
        .await
}

#[tauri::command]
pub async fn load_workspace(app: AppHandle) -> Result<Option<String>, String> {
    run_blocking(move || workspace_file::load(&app).map_err(|e| e.to_string())).await
}

#[tauri::command]
pub async fn save_workspace(app: AppHandle, json: String) -> Result<(), String> {
    run_blocking(move || workspace_file::save(&app, &json).map_err(|e| e.to_string())).await
}

/// Open a link from agent-rendered markdown in the system browser. The
/// webview itself never navigates; only web-ish schemes get out.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let trimmed = url.trim().to_owned();
    let lower = trimmed.to_ascii_lowercase();
    let allowed = ["http://", "https://", "mailto:"];
    if !allowed.iter().any(|scheme| lower.starts_with(scheme)) {
        return Err("Only http(s) and mailto links can be opened.".to_owned());
    }
    open_with_default_app(&trimmed).map_err(|e| format!("Could not open the link: {e}"))
}

/// Open one of the project's files in whatever app the OS associates
/// with it. Deliberately separate from `open_external`, whose scheme
/// allowlist exists precisely to keep local paths out.
///
/// `path` is repo-controlled (it comes from `git status`), so it is
/// resolved and checked to still be inside the project folder: a symlink
/// or a `..` in a hostile repo must not turn "open this changed file"
/// into "open anything on the disk".
#[tauri::command]
pub fn open_path(project_path: String, path: String) -> Result<(), String> {
    let root = std::path::Path::new(&project_path)
        .canonicalize()
        .map_err(|e| format!("Could not resolve the project folder: {e}"))?;
    let target = root
        .join(&path)
        .canonicalize()
        .map_err(|_| format!("{path} is not on disk any more."))?;

    if !target.starts_with(&root) {
        return Err(format!("Refusing to open {path}: it leaves the project folder."));
    }
    if !target.is_file() {
        return Err(format!("{path} is not a file."));
    }

    let as_str = target
        .to_str()
        .ok_or_else(|| format!("{path} has a name this platform cannot pass on."))?;
    open_with_default_app(shell_path(as_str)).map_err(|e| format!("Could not open {path}: {e}"))
}

/// Open the user extensions folder (`~/.mota/extensions`) in the system
/// file manager, creating it first so a fresh install has somewhere to
/// drop an extension into.
#[tauri::command]
pub fn open_extensions_dir(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .home_dir()
        .map_err(|e| format!("Could not find your home folder: {e}"))?
        .join(".mota")
        .join("extensions");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create the extensions folder: {e}"))?;
    let as_str = dir
        .to_str()
        .ok_or("The extensions folder has a name this platform cannot pass on.")?;
    open_with_default_app(as_str).map_err(|e| format!("Could not open the extensions folder: {e}"))
}

/// `canonicalize` hands back a `\\?\`-prefixed path on Windows, which the
/// shell APIs behind the opener do not understand. Elsewhere it is a
/// no-op.
fn shell_path(path: &str) -> &str {
    path.strip_prefix(r"\\?\").unwrap_or(path)
}

/// The URL or path travels as plain argv — no shell ever parses it.
#[cfg(windows)]
fn open_with_default_app(url: &str) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("rundll32")
        .arg("url.dll,FileProtocolHandler")
        .arg(url)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn open_with_default_app(url: &str) -> std::io::Result<()> {
    std::process::Command::new("open").arg(url).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_with_default_app(url: &str) -> std::io::Result<()> {
    std::process::Command::new("xdg-open").arg(url).spawn().map(|_| ())
}

/// A pasted image arrives as bytes with no path of its own. Give it one
/// under the system temp folder so it can travel with the prompt exactly
/// like a picked file — attachments are paths everywhere, never blobs.
#[tauri::command]
pub fn save_pasted_image(data: String, mime_type: String) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|e| format!("Could not decode the pasted image: {e}"))?;
    if bytes.is_empty() {
        return Err("The pasted image is empty.".to_owned());
    }

    let dir = std::env::temp_dir().join("mota-editor").join("pasted");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create the paste folder: {e}"))?;

    // Millis + a process-wide counter: unique even for pastes that land
    // within the same clock tick.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = PASTE_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("pasted-{stamp}-{seq}.{}", image_extension(&mime_type)));

    std::fs::write(&path, bytes)
        .map_err(|e| format!("Could not save the pasted image: {e}"))?;
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "The temp folder has a name this platform cannot pass on.".to_owned())
}

static PASTE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn image_extension(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        _ => "png",
    }
}

fn spawn_error(provider_id: &str, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        format!("The `{provider_id}` CLI was not found on your PATH.")
    } else {
        format!("Could not start `{provider_id}`: {error}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pasted_image_lands_on_disk_with_the_mime_extension() {
        use base64::Engine as _;
        let bytes = [137u8, 80, 78, 71];
        let data = base64::engine::general_purpose::STANDARD.encode(bytes);
        let path = save_pasted_image(data, "image/jpeg".to_owned()).unwrap();
        assert!(path.ends_with(".jpg"), "unexpected path: {path}");
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn garbage_base64_is_rejected() {
        assert!(save_pasted_image("not base64!!".into(), "image/png".into()).is_err());
    }

    #[test]
    fn unknown_mime_types_fall_back_to_png() {
        assert_eq!(image_extension("image/png"), "png");
        assert_eq!(image_extension("image/webp"), "webp");
        assert_eq!(image_extension("application/octet-stream"), "png");
    }

    #[test]
    fn a_slashed_model_id_is_a_valid_token() {
        // Gateway-routed providers name models `vendor/model`; rejecting the
        // slash would fail every such turn before anything is spawned.
        assert_eq!(
            validate_token(Some("opencode/grok-code-fast-1".to_owned()), "model").unwrap(),
            Some("opencode/grok-code-fast-1".to_owned())
        );
    }

    #[test]
    fn a_token_that_could_pass_for_a_flag_is_rejected() {
        assert!(validate_token(Some("--dangerously-skip".to_owned()), "model").is_err());
        assert!(validate_token(Some("-m".to_owned()), "effort").is_err());
    }

    #[test]
    fn quoting_and_shell_metacharacters_are_still_rejected() {
        for smuggled in ["a b", "a;b", "a$(b)", "a\"b", "a|b", "a\\b"] {
            assert!(
                validate_token(Some(smuggled.to_owned()), "model").is_err(),
                "should have rejected: {smuggled}"
            );
        }
    }

    #[test]
    fn blank_and_absent_tokens_mean_the_provider_default() {
        assert_eq!(validate_token(None, "model").unwrap(), None);
        assert_eq!(validate_token(Some("   ".to_owned()), "model").unwrap(), None);
    }
}
