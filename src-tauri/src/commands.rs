//! Tauri command handlers — the controllers of the interface-adapter
//! layer. Thin by design: validate, delegate, return.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

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
pub struct RunningTurns(pub Mutex<HashMap<String, tokio::sync::mpsc::Sender<()>>>);

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

    {
        let running = turns.0.lock().unwrap_or_else(PoisonError::into_inner);
        if running.contains_key(&args.tab_id) {
            return Err("A turn is already running in this tab.".to_owned());
        }
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
    )
    .await
    {
        Ok(()) => return Ok(()),
        Err(AcpStartError::Failed(message)) => return Err(message),
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

    let command = provider.build_command(&request);
    let child: Child =
        runner::spawn(&command, &project_path).map_err(|e| spawn_error(provider.id(), &e))?;

    let (cancel_tx, mut cancel_rx) = tokio::sync::mpsc::channel::<()>(1);
    turns.0.lock().unwrap_or_else(PoisonError::into_inner).insert(args.tab_id.clone(), cancel_tx);

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
        })
    }
}

/// Models and efforts are picker values in the UI, but they travel into
/// provider command lines and config strings — restrict them to plain
/// tokens so nothing can smuggle flags or quoting along.
fn validate_token(value: Option<String>, what: &str) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Ok(None);
    }
    let plain = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'));
    if plain {
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
#[tauri::command]
pub async fn list_agent_sessions(
    app: AppHandle,
    acp: State<'_, AcpSessions>,
    args: WarmSessionArgs,
) -> Result<serde_json::Value, String> {
    acp_session::list_native_sessions(app, &acp, &args.tab_id, &args.provider_id, &args.spec()?)
        .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadSessionArgs {
    #[serde(flatten)]
    pub warm: WarmSessionArgs,
    pub session_id: String,
}

/// Truly resume one of the agent's saved sessions in this tab.
#[tauri::command]
pub async fn load_agent_session(
    app: AppHandle,
    acp: State<'_, AcpSessions>,
    args: LoadSessionArgs,
) -> Result<(), String> {
    acp_session::load_native_session(
        app,
        &acp,
        &args.warm.tab_id,
        &args.warm.provider_id,
        &args.warm.spec()?,
        &args.session_id,
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
    acp_session::cancel_turn(&acp, &tab_id).await;
    let sender = turns.0.lock().unwrap_or_else(PoisonError::into_inner).remove(&tab_id);
    if let Some(sender) = sender {
        let _ = sender.send(()).await;
    }
    Ok(())
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

#[tauri::command]
pub async fn end_session(
    turns: State<'_, RunningTurns>,
    acp: State<'_, AcpSessions>,
    tab_id: String,
) -> Result<(), String> {
    acp.end_session(&tab_id);
    let sender = turns.0.lock().unwrap_or_else(PoisonError::into_inner).remove(&tab_id);
    if let Some(sender) = sender {
        let _ = sender.send(()).await;
    }
    Ok(())
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
    open_in_browser(&trimmed).map_err(|e| format!("Could not open the link: {e}"))
}

/// The URL travels as plain argv — no shell ever parses it.
#[cfg(windows)]
fn open_in_browser(url: &str) -> std::io::Result<()> {
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
fn open_in_browser(url: &str) -> std::io::Result<()> {
    std::process::Command::new("open").arg(url).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_in_browser(url: &str) -> std::io::Result<()> {
    std::process::Command::new("xdg-open").arg(url).spawn().map(|_| ())
}

fn spawn_error(provider_id: &str, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        format!("The `{provider_id}` CLI was not found on your PATH.")
    } else {
        format!("Could not start `{provider_id}`: {error}")
    }
}
