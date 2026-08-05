//! Is this provider ready to work? — a short-lived ACP handshake used by
//! the settings screen, so "Claude isn't signed in" is something the user
//! reads BEFORE sending a prompt rather than as a failed turn.
//!
//! Deliberately not built on `AcpSession`: that registers a long-lived
//! session against a tab, and a probe must leave no trace. The exchange
//! here is small enough to speak raw JSON-RPC over the child's stdio.

use std::time::Duration;

use agent_core::acp;
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::acp_session::{spawn_agent, AcpStartError};

/// Long enough for `npx` to resolve a package on a cold cache, short
/// enough that a wedged agent doesn't hang the settings screen.
const PROBE_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: String,
    /// The agent binary launched and spoke ACP.
    pub installed: bool,
    /// It also opened a session — the real proof it can do work.
    pub authenticated: bool,
    /// What to show the user: the agent's own words where there are any.
    pub detail: String,
    /// How to install it, when it isn't.
    pub install_hint: String,
}

#[tauri::command]
pub async fn probe_provider(
    _app: AppHandle,
    provider_id: String,
    project_path: String,
) -> Result<ProviderStatus, String> {
    Ok(probe(&provider_id, &project_path).await)
}

async fn probe(provider_id: &str, project_path: &str) -> ProviderStatus {
    let install_hint = acp::agent_commands(provider_id)
        .first()
        .map(|c| c.install_hint.to_owned())
        .unwrap_or_default();

    match handshake(provider_id, project_path).await {
        Ok(detail) => ProviderStatus {
            provider: provider_id.to_owned(),
            installed: true,
            authenticated: true,
            detail,
            install_hint,
        },
        // The agent never started: not installed, or not on PATH.
        Err(AcpStartError::Unavailable(detail)) => ProviderStatus {
            provider: provider_id.to_owned(),
            installed: false,
            authenticated: false,
            detail,
            install_hint,
        },
        // It started and then refused — almost always a missing login.
        Err(AcpStartError::Failed(detail)) => ProviderStatus {
            provider: provider_id.to_owned(),
            installed: true,
            authenticated: false,
            detail,
            install_hint,
        },
    }
}

/// `initialize` proves the agent runs; `session/new` proves it can work.
/// Only the second one fails when the user hasn't signed in, which is why
/// the probe pays for both.
async fn handshake(provider_id: &str, project_path: &str) -> Result<String, AcpStartError> {
    let (mut child, _) = spawn_agent(provider_id, project_path, None, None)?;
    let mut stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    let mut lines = BufReader::new(stdout).lines();

    let result = tokio::time::timeout(PROBE_TIMEOUT, async {
        let init = request(&mut stdin, &mut lines, acp::initialize_request(0), 0)
            .await
            .map_err(AcpStartError::Unavailable)?;

        // No MCP servers: the probe asks "can you work at all?", and a
        // failing server would answer a different question.
        request(
            &mut stdin,
            &mut lines,
            acp::session_new_request(1, project_path, &[]),
            1,
        )
        .await
        .map_err(AcpStartError::Failed)?;

        Ok(describe(&init))
    })
    .await
    .unwrap_or_else(|_| {
        Err(AcpStartError::Failed(
            "The agent did not respond in time.".to_owned(),
        ))
    });

    let _ = child.start_kill();
    result
}

/// Write one request and read until its response arrives, skipping the
/// notifications an agent may volunteer in between.
async fn request(
    stdin: &mut tokio::process::ChildStdin,
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    message: Value,
    id: i64,
) -> Result<Value, String> {
    let line = format!("{message}\n");
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())?;

    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("id").and_then(Value::as_i64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the agent rejected the request");
            return Err(message.to_owned());
        }
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
    Err("The agent closed without answering.".to_owned())
}

/// A one-line summary of what the agent said about itself.
fn describe(init_result: &Value) -> String {
    let name = init_result
        .pointer("/agentInfo/name")
        .and_then(Value::as_str)
        .unwrap_or("agent");
    let auth_methods = init_result
        .get("authMethods")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    if auth_methods > 0 {
        format!("Connected via {name}; it also offers {auth_methods} sign-in method(s).")
    } else {
        format!("Connected via {name}.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn describes_a_plain_connection() {
        let result = json!({ "agentInfo": { "name": "claude-agent-acp" } });
        assert_eq!(describe(&result), "Connected via claude-agent-acp.");
    }

    #[test]
    fn mentions_sign_in_methods_when_the_agent_lists_them() {
        let result = json!({
            "agentInfo": { "name": "codex-acp" },
            "authMethods": [{ "id": "oauth" }]
        });
        assert!(describe(&result).contains("1 sign-in method"));
    }

    #[test]
    fn falls_back_when_the_agent_names_itself_nothing() {
        assert_eq!(describe(&json!({})), "Connected via agent.");
    }
}
