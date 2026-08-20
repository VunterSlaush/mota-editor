//! Command optimization — runs one headless analysis turn that distills
//! a slash command's markdown into a deterministic script proposal. The
//! reply is returned raw; the frontend core owns parsing the verdict.

use std::path::PathBuf;
use std::time::Duration;

use std::io::Write;

use agent_core::commands::{content_hash, optimize_prompt, rewrite_prompt, RewriteBlocker};
use agent_core::{provider_for, AgentEvent, Mode, Permission, Provider, TurnRequest};
use serde::Serialize;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Child;

use crate::command_discovery::{copy_target_dir, find_command_body};
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
    evidence: Option<String>,
) -> Result<OptimizeRunResult, String> {
    run_headless_analysis(app, project_path, provider_id, command_name, move |name, body| {
        optimize_prompt(name, body, evidence.as_deref())
    })
    .await
}

/// Second pass for a command judged not optimizable: ask for an
/// optimized VARIANT — rewritten command text plus its script — with
/// the stored blockers echoed back so the advice is what gets applied.
#[tauri::command]
pub async fn rewrite_command(
    app: AppHandle,
    project_path: String,
    provider_id: String,
    command_name: String,
    blockers: Vec<RewriteBlocker>,
    evidence: Option<String>,
) -> Result<OptimizeRunResult, String> {
    run_headless_analysis(app, project_path, provider_id, command_name, move |name, body| {
        rewrite_prompt(name, body, &blockers, evidence.as_deref())
    })
    .await
}

async fn run_headless_analysis(
    app: AppHandle,
    project_path: String,
    provider_id: String,
    command_name: String,
    build_prompt: impl FnOnce(&str, &str) -> String,
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
        prompt: build_prompt(&command_name, &body),
        project_path: project_path.clone(),
        resume_session_id: None,
        mode: Mode::Agent,
        permission: Permission::Manual,
        attachments: Vec::new(),
        model: None,
        effort: None,
        // No subtask scope: the analysis run belongs to no tab, and it
        // reads the command's markdown rather than the project's files.
        subtask: None,
    };
    let command = provider.build_command(&request);
    let child = runner::spawn(&command, &project)
        .map_err(|e| spawn_error(provider.id(), &e))?;

    let text = tokio::time::timeout(ANALYSIS_TIMEOUT, collect_turn(provider, child))
        .await
        .map_err(|_| "The analysis run timed out.".to_owned())??;
    Ok(OptimizeRunResult { text, content_hash: content_hash(&body) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCommandCopy {
    /// The new command's slash name, e.g. "/start-preview-optimized".
    pub name: String,
    /// Hash of the written file, the new record's `sourceHash`.
    pub content_hash: String,
}

/// Anything past this is not a command file, whatever the model says.
const MAX_COMMAND_FILE_BYTES: usize = 256 * 1024;

/// Write the rewritten variant NEXT TO its source as `<name>-optimized.md`,
/// refusing to overwrite: the copy is a new command, never a replacement.
#[tauri::command]
pub async fn save_command_copy(
    app: AppHandle,
    project_path: String,
    provider_id: String,
    source_name: String,
    content: String,
) -> Result<SavedCommandCopy, String> {
    if content.trim().is_empty() || content.len() > MAX_COMMAND_FILE_BYTES {
        return Err("The rewritten command text is empty or implausibly large.".to_owned());
    }
    run_blocking(move || {
        let stem = source_name.strip_prefix('/').unwrap_or(&source_name);
        if stem.is_empty()
            || !stem.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
        {
            return Err(format!("Invalid command name: {source_name}"));
        }
        let dir = copy_target_dir(&app, &project_path, &provider_id, &source_name)
            .ok_or_else(|| {
                format!("No folder found to place a Markdown copy of {source_name} in.")
            })?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let new_stem = format!("{stem}-optimized");
        let path = dir.join(format!("{new_stem}.md"));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    format!("/{new_stem} already exists — remove it first to re-create it.")
                } else {
                    e.to_string()
                }
            })?;
        file.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
        Ok(SavedCommandCopy {
            name: format!("/{new_stem}"),
            content_hash: content_hash(&content),
        })
    })
    .await
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
