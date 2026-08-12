//! Command optimization — runs one headless analysis turn that distills
//! a slash command's markdown into a deterministic script proposal. The
//! reply is returned raw; the frontend core owns parsing the verdict.

use std::path::PathBuf;
use std::time::Duration;

use agent_core::commands::{content_hash, optimize_prompt};
use agent_core::{provider_for, AgentEvent, Mode, Permission, Provider, TurnRequest};
use serde::Serialize;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Child;

use crate::command_discovery::find_command_body;
use crate::commands::{run_blocking, spawn_error};
use crate::runner;

/// Analysis is one prompt over inlined markdown — minutes means wedged,
/// not thorough. The child is killed on drop when this expires.
const ANALYSIS_TIMEOUT: Duration = Duration::from_secs(180);

const MAX_CAPTURE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeRunResult {
    /// The model's reply, verbatim; the core parses the JSON verdict.
    pub text: String,
    /// Hash of the markdown that was analyzed, for staleness checks.
    pub content_hash: String,
}

#[tauri::command]
pub async fn optimize_command(
    app: AppHandle,
    project_path: String,
    provider_id: String,
    command_name: String,
) -> Result<OptimizeRunResult, String> {
    let provider = provider_for(&provider_id)
        .ok_or_else(|| format!("Unknown provider: {provider_id}"))?;
    let project = PathBuf::from(&project_path);
    if !project.is_dir() {
        return Err(format!("Project folder not found: {project_path}"));
    }

    let body = {
        let (app, project_path, provider_id, name) =
            (app.clone(), project_path.clone(), provider_id.clone(), command_name.clone());
        run_blocking(move || {
            find_command_body(&app, &project_path, &provider_id, &name)
                .ok_or_else(|| format!("No file found for {name}."))
        })
        .await?
    };

    // Manual permission in headless mode cannot prompt, so the CLI denies
    // tool use outright — the analysis model reads the inlined markdown
    // and answers, nothing more. That is the point, not a limitation.
    let request = TurnRequest {
        prompt: optimize_prompt(&command_name, &body),
        project_path: project_path.clone(),
        resume_session_id: None,
        mode: Mode::Agent,
        permission: Permission::Manual,
        attachments: Vec::new(),
        model: None,
        effort: None,
    };
    let command = provider.build_command(&request);
    let child = runner::spawn(&command, &project)
        .map_err(|e| spawn_error(provider.id(), &e))?;

    let text = tokio::time::timeout(ANALYSIS_TIMEOUT, collect_turn(provider, child))
        .await
        .map_err(|_| "The analysis run timed out.".to_owned())??;
    Ok(OptimizeRunResult { text, content_hash: content_hash(&body) })
}

/// `runner::stream_turn`'s quiet sibling: same pumping and stderr
/// draining, but the turn's text is collected and returned instead of
/// emitted as events — nothing here belongs in a chat tab.
async fn collect_turn(provider: &'static dyn Provider, mut child: Child) -> Result<String, String> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Same deadlock guard as stream_turn: a child blocked on a full
    // stderr pipe never finishes writing stdout.
    let stderr_task = stderr.map(|stderr| {
        tokio::spawn(async move {
            let mut text = String::new();
            let _ = stderr.take(MAX_CAPTURE_BYTES as u64).read_to_string(&mut text).await;
            text
        })
    });

    let mut streamed = String::new();
    let mut final_result: Option<String> = None;
    let mut is_error = false;
    let mut completed = false;

    if let Some(stdout) = stdout {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            for event in provider.parse_line(&line) {
                match event {
                    AgentEvent::AssistantMessage { text } => {
                        if streamed.len() < MAX_CAPTURE_BYTES {
                            streamed.push_str(&text);
                            streamed.push('\n');
                        }
                    }
                    AgentEvent::TurnCompleted { result, is_error: error, .. } => {
                        final_result = result;
                        is_error = error;
                        completed = true;
                    }
                    _ => {}
                }
            }
        }
    }

    let stderr_text = match stderr_task {
        Some(task) => task.await.unwrap_or_default(),
        None => String::new(),
    };
    let status = child.wait().await;

    // The provider's final result is the authoritative reply text when
    // it carries one; streamed assistant text covers providers that
    // complete without repeating it.
    let text = final_result.filter(|t| !t.trim().is_empty()).unwrap_or(streamed);
    let exited_ok = status.map(|s| s.success()).unwrap_or(false);
    if is_error || (!completed && !exited_ok) {
        return Err(analysis_failure(&text, &stderr_text));
    }
    if text.trim().is_empty() {
        return Err("The analysis run produced no reply.".to_owned());
    }
    Ok(text)
}

fn analysis_failure(reply: &str, stderr_text: &str) -> String {
    let detail = if !reply.trim().is_empty() { reply } else { stderr_text };
    let tail: Vec<&str> = detail.lines().rev().take(5).collect();
    let tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
    if tail.trim().is_empty() {
        "The analysis run failed.".to_owned()
    } else {
        format!("The analysis run failed: {tail}")
    }
}
