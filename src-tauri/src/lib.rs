//! Shell crate (Frameworks & Drivers layer) — wires Tauri to the
//! `agent-core` domain. Contains only glue: command handlers, the
//! process runner, and workspace persistence.

mod acp_session;
mod command_discovery;
mod commands;
mod git;
mod history_file;
mod provider_probe;
mod runner;
mod workspace_file;

use acp_session::AcpSessions;
use commands::RunningTurns;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // The window is built here rather than in tauri.conf.json so a
        // navigation guard can be attached: the app is a local SPA and
        // the webview must never navigate to a remote origin (agent
        // markdown links open in the system browser instead).
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("Mota Editor")
            .inner_size(1100.0, 750.0)
            .min_inner_size(640.0, 480.0)
            .on_navigation(|url| {
                matches!(url.scheme(), "tauri" | "asset" | "about")
                    || matches!(
                        url.host_str(),
                        Some("localhost") | Some("tauri.localhost") | Some("asset.localhost")
                    )
            })
            .build()?;
            Ok(())
        })
        .manage(RunningTurns::default())
        .manage(AcpSessions::default())
        .invoke_handler(tauri::generate_handler![
            commands::start_turn,
            commands::warm_session,
            commands::list_agent_sessions,
            commands::load_agent_session,
            commands::read_plan_file,
            commands::cancel_turn,
            commands::respond_permission,
            commands::end_session,
            commands::list_custom_commands,
            commands::open_external,
            provider_probe::probe_provider,
            git::git_status,
            git::git_log,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_branches,
            git::git_checkout,
            git::git_push,
            git::git_pull,
            commands::load_workspace,
            commands::save_workspace,
            history_file::save_session,
            history_file::list_sessions,
            history_file::load_session,
            history_file::delete_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running mota-editor");
}
