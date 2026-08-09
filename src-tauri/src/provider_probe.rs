//! Is this provider ready to work? — a short-lived ACP handshake used by
//! the settings screen, so "Claude isn't signed in" is something the user
//! reads BEFORE sending a prompt rather than as a failed turn.
//!
//! The wire work lives in `acp_session::probe_handshake`, on the same
//! code real sessions use; this module only shapes the answer.
//!
//! What the handshake can and cannot prove is the whole design here. The
//! Claude adapter opens a session without touching credentials and only
//! authenticates on the first prompt, so a successful handshake is NOT
//! proof of sign-in. Rather than spend a request (and the user's quota)
//! on every settings visit, the probe reports `started` — honestly
//! uncertain — and a provider only reaches `ready` once a real turn has
//! come back clean. See `docs/adr/0004-provider-readiness.md`.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::Duration;

use agent_core::acp;
use serde::Serialize;
use tauri::AppHandle;

use crate::acp_session::{probe_handshake, AcpStartError};

/// Long enough for `npx` to resolve a package on a cold cache, short
/// enough that a wedged agent doesn't hang the settings screen.
const PROBE_TIMEOUT: Duration = Duration::from_secs(45);

/// How ready a provider is, worst to best. Serialized in camelCase to
/// match the frontend's `Readiness` union.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Readiness {
    /// The agent never launched: not installed, or not on PATH.
    NotInstalled,
    /// It launched and then refused, in words that name a login problem.
    SignInRequired,
    /// It launched and opened a session, but that does not exercise
    /// credentials — the first turn is where sign-in is really tested.
    Started,
    /// A real turn has succeeded with this provider.
    Ready,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: String,
    pub readiness: Readiness,
    /// What to show the user: the agent's own words where there are any.
    pub detail: String,
    /// How to install it, when it isn't installed.
    pub install_hint: String,
    /// The sign-in command as a user would type it, when we know one —
    /// shown as the copyable fallback beside the Sign in button.
    pub sign_in_command: String,
}

#[tauri::command]
pub async fn probe_provider(
    app: AppHandle,
    provider_id: String,
    project_path: String,
) -> Result<ProviderStatus, String> {
    Ok(probe(&app, &provider_id, &project_path).await)
}

/// Providers whose credentials a completed turn has proven good, for this
/// run of the app. Deliberately not persisted: a token that worked
/// yesterday tells the user nothing about today.
fn verified() -> &'static Mutex<HashSet<String>> {
    static VERIFIED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    VERIFIED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Record that a turn completed for this provider — called from the ACP
/// session, and the only way a provider reaches `Ready`.
pub fn mark_verified(provider_id: &str) {
    verified()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(provider_id.to_owned());
}

fn is_verified(provider_id: &str) -> bool {
    verified()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .contains(provider_id)
}

async fn probe(app: &AppHandle, provider_id: &str, project_path: &str) -> ProviderStatus {
    let install_hint = acp::agent_commands(provider_id)
        .first()
        .map(|c| c.install_hint.to_owned())
        .unwrap_or_default();
    let sign_in_command = acp::sign_in_command(provider_id)
        .map(|c| c.display())
        .unwrap_or_default();

    let (readiness, detail) = match probe_handshake(app, provider_id, project_path, PROBE_TIMEOUT)
        .await
    {
        Ok(caps) => outcome_for_started(provider_id, &caps),
        Err(AcpStartError::Unavailable(detail)) => (Readiness::NotInstalled, detail),
        Err(AcpStartError::Failed(detail)) => (classify_failure(&detail), detail),
    };

    ProviderStatus {
        provider: provider_id.to_owned(),
        readiness,
        detail,
        install_hint,
        sign_in_command,
    }
}

/// The agent started and opened a session. Whether that counts as ready
/// depends on something the handshake cannot see.
fn outcome_for_started(provider_id: &str, caps: &acp::AgentCaps) -> (Readiness, String) {
    let name = caps.agent_name.as_deref().unwrap_or("agent");
    if is_verified(provider_id) {
        return (Readiness::Ready, format!("Connected via {name}; a turn has run."));
    }
    (
        Readiness::Started,
        format!("Started via {name}. Sign-in is confirmed on the first message."),
    )
}

/// It started and then refused. A login problem is worth naming; anything
/// else stays generic rather than guessing.
fn classify_failure(detail: &str) -> Readiness {
    if acp::is_auth_failure(detail) {
        Readiness::SignInRequired
    } else {
        Readiness::Started
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(name: &str) -> acp::AgentCaps {
        acp::AgentCaps { agent_name: Some(name.into()), ..Default::default() }
    }

    #[test]
    fn a_handshake_alone_is_not_proof_of_sign_in() {
        let (readiness, detail) = outcome_for_started("codex", &caps("codex-acp"));
        assert_eq!(readiness, Readiness::Started);
        assert!(detail.contains("codex-acp"));
        assert!(detail.contains("first message"));
    }

    #[test]
    fn a_completed_turn_promotes_the_provider_to_ready() {
        mark_verified("gemini");
        let (readiness, detail) = outcome_for_started("gemini", &caps("gemini"));
        assert_eq!(readiness, Readiness::Ready);
        assert!(detail.contains("a turn has run"));
    }

    #[test]
    fn falls_back_when_the_agent_names_itself_nothing() {
        let (_, detail) = outcome_for_started("nobody", &acp::AgentCaps::default());
        assert!(detail.starts_with("Started via agent."));
    }

    #[test]
    fn a_refusal_that_names_a_login_problem_asks_for_sign_in() {
        assert_eq!(
            classify_failure("Failed to authenticate: OAuth session expired"),
            Readiness::SignInRequired
        );
    }

    #[test]
    fn an_unrelated_refusal_does_not_claim_a_login_problem() {
        assert_eq!(classify_failure("the project path does not exist"), Readiness::Started);
    }
}
