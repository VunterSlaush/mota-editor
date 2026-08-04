//! Tauri command handlers — the controllers of the interface-adapter
//! layer. Thin by design: validate, delegate, return.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use agent_core::{provider_for, AgentEvent, Mode, Permission, TurnRequest};
use serde::Deserialize;
use tauri::{AppHandle, Manager, State};
use tokio::process::Child;

use crate::acp_session::{self, AcpSessions, AcpStartError};
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
        let running = turns.0.lock().unwrap();
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
        model: args.model.filter(|m| !m.trim().is_empty()),
        effort: args.effort.filter(|e| !e.trim().is_empty()),
    };

    // Preferred transport: a persistent ACP session (interactive
    // approvals, streaming). Falls back to one-shot headless mode when
    // the provider's ACP agent isn't available on this machine.
    match acp_session::start_turn(app.clone(), &acp, &args.tab_id, provider.id(), request.clone())
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
    turns.0.lock().unwrap().insert(args.tab_id.clone(), cancel_tx);

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
        turns.0.lock().unwrap().remove(&tab_id);
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
    acp_session::warm(
        app,
        &acp,
        &args.tab_id,
        &args.provider_id,
        &args.project_path,
        args.model.filter(|m| !m.trim().is_empty()),
        args.effort.filter(|e| !e.trim().is_empty()),
    )
    .await;
    Ok(())
}

/// The agent's own saved sessions for this project (native history).
#[tauri::command]
pub async fn list_agent_sessions(
    app: AppHandle,
    acp: State<'_, AcpSessions>,
    args: WarmSessionArgs,
) -> Result<serde_json::Value, String> {
    acp_session::list_native_sessions(
        app,
        &acp,
        &args.tab_id,
        &args.provider_id,
        &args.project_path,
        args.model.filter(|m| !m.trim().is_empty()),
        args.effort.filter(|e| !e.trim().is_empty()),
    )
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
        &args.warm.project_path,
        args.warm.model.filter(|m| !m.trim().is_empty()),
        args.warm.effort.filter(|e| !e.trim().is_empty()),
        &args.session_id,
    )
    .await
}

/// Read a plan file the agent saved (history stores the path, not the
/// content). Restricted to markdown files.
#[tauri::command]
pub fn read_plan_file(path: String) -> Result<Option<String>, String> {
    if !path.ends_with(".md") {
        return Err("Not a markdown file.".to_owned());
    }
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn cancel_turn(
    turns: State<'_, RunningTurns>,
    acp: State<'_, AcpSessions>,
    tab_id: String,
) -> Result<(), String> {
    acp_session::cancel_turn(&acp, &tab_id).await;
    let sender = turns.0.lock().unwrap().remove(&tab_id);
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
    let sender = turns.0.lock().unwrap().remove(&tab_id);
    if let Some(sender) = sender {
        let _ = sender.send(()).await;
    }
    Ok(())
}

#[tauri::command]
pub fn list_custom_commands(
    app: AppHandle,
    project_path: String,
    provider_id: String,
) -> Result<Vec<command_discovery::CustomCommand>, String> {
    Ok(command_discovery::discover(&app, &project_path, &provider_id))
}

#[tauri::command]
pub fn load_workspace(app: AppHandle) -> Result<Option<String>, String> {
    workspace_file::load(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_workspace(app: AppHandle, json: String) -> Result<(), String> {
    workspace_file::save(&app, &json).map_err(|e| e.to_string())
}

fn spawn_error(provider_id: &str, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        format!("The `{provider_id}` CLI was not found on your PATH.")
    } else {
        format!("Could not start `{provider_id}`: {error}")
    }
}
