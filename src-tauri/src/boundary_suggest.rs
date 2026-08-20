//! "Suggest boundaries" — one agent question, asked because the user
//! pressed a button, answered into the Subtasks settings section.
//!
//! The wire work is `acp_session::ask_once` (a throwaway read-only
//! session, so nothing lands in a tab's conversation); the prompt and the
//! parsing are pure and live in `agent_core::scope`. This module only
//! connects the two and bounds how long it may take.
//!
//! Grouping a monorepo is one question with a short answer, but the agent
//! reads workspace manifests to answer it well, and a cold `npx` boot is
//! already most of a minute — hence a timeout well past the probe's.

use std::time::Duration;

use agent_core::scope::{
    boundary_suggestion_prompt, parse_boundary_suggestions, SuggestedBoundary,
};
use tauri::AppHandle;

use crate::acp_session::{ask_once, AcpStartError};

/// Long enough for a cold agent to boot and read a few manifests, short
/// enough that a wedged one gives the settings screen its button back.
const SUGGEST_TIMEOUT: Duration = Duration::from_secs(180);

/// How many folders the prompt ever lists. A deep repository can have
/// thousands; the top of the tree is where areas live, and an unbounded
/// list would spend the user's tokens on noise.
const FOLDER_LIMIT: usize = 200;

#[tauri::command]
pub async fn suggest_boundaries(
    app: AppHandle,
    provider_id: String,
    project_path: String,
    folders: Vec<String>,
) -> Result<Vec<SuggestedBoundary>, String> {
    if folders.is_empty() {
        return Err("This project has no folders to group.".to_owned());
    }
    let listed: Vec<String> = folders.into_iter().take(FOLDER_LIMIT).collect();
    let prompt = boundary_suggestion_prompt(&listed);

    let reply = ask_once(&app, &provider_id, &project_path, &prompt, SUGGEST_TIMEOUT)
        .await
        .map_err(|e| match e {
            // Both halves are the user's to act on: one means "install or
            // sign in", the other is the agent's own complaint.
            AcpStartError::Unavailable(reason) => {
                format!("{provider_id} is not available: {reason}")
            }
            AcpStartError::Failed(message) => message,
        })?;

    let suggestions = parse_boundary_suggestions(&reply);
    if suggestions.is_empty() {
        // The agent answered, just not usefully. Saying so beats an empty
        // list that reads as "your project has no areas".
        return Err(
            "The agent did not answer with any usable folder groups. Try again, or add \
             the folders by hand."
                .to_owned(),
        );
    }
    Ok(suggestions)
}
