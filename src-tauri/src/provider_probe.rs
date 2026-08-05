//! Is this provider ready to work? — a short-lived ACP handshake used by
//! the settings screen, so "Claude isn't signed in" is something the user
//! reads BEFORE sending a prompt rather than as a failed turn.
//!
//! The wire work lives in `acp_session::probe_handshake`, on the same
//! code real sessions use; this module only shapes the answer.

use std::time::Duration;

use agent_core::acp;
use serde::Serialize;
use tauri::AppHandle;

use crate::acp_session::{probe_handshake, AcpStartError};

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
    app: AppHandle,
    provider_id: String,
    project_path: String,
) -> Result<ProviderStatus, String> {
    Ok(probe(&app, &provider_id, &project_path).await)
}

async fn probe(app: &AppHandle, provider_id: &str, project_path: &str) -> ProviderStatus {
    let install_hint = acp::agent_commands(provider_id)
        .first()
        .map(|c| c.install_hint.to_owned())
        .unwrap_or_default();

    match probe_handshake(app, provider_id, project_path, PROBE_TIMEOUT).await {
        Ok(caps) => ProviderStatus {
            provider: provider_id.to_owned(),
            installed: true,
            authenticated: true,
            detail: describe(&caps),
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

/// A one-line summary of what the agent said about itself.
fn describe(caps: &acp::AgentCaps) -> String {
    let name = caps.agent_name.as_deref().unwrap_or("agent");
    if caps.auth_method_count > 0 {
        format!(
            "Connected via {name}; it also offers {} sign-in method(s).",
            caps.auth_method_count
        )
    } else {
        format!("Connected via {name}.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_a_plain_connection() {
        let caps = acp::AgentCaps {
            agent_name: Some("claude-agent-acp".into()),
            ..Default::default()
        };
        assert_eq!(describe(&caps), "Connected via claude-agent-acp.");
    }

    #[test]
    fn mentions_sign_in_methods_when_the_agent_lists_them() {
        let caps = acp::AgentCaps {
            agent_name: Some("codex-acp".into()),
            auth_method_count: 1,
            ..Default::default()
        };
        assert!(describe(&caps).contains("1 sign-in method"));
    }

    #[test]
    fn falls_back_when_the_agent_names_itself_nothing() {
        assert_eq!(describe(&acp::AgentCaps::default()), "Connected via agent.");
    }
}
