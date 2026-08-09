//! Shell crate (Frameworks & Drivers layer) — wires Tauri to the
//! `agent-core` domain. Contains only glue: command handlers, the
//! process runner, and workspace persistence.

mod acp_session;
mod billing_log;
mod command_discovery;
mod commands;
mod mcp_probe;
mod git;
mod history_file;
mod provider_probe;
mod runner;
mod shell_env;
mod sign_in;
mod terminal;
mod workspace_file;

use acp_session::AcpSessions;
use commands::RunningTurns;

pub fn run() {
    // Before anything resolves a program name: a Finder-launched macOS
    // app would otherwise search launchd's bare PATH and conclude the
    // user's agent CLIs aren't installed.
    shell_env::import_login_shell_env();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // The window is built here rather than in tauri.conf.json so a
        // navigation guard can be attached: the app is a local SPA and
        // the webview must never navigate to a remote origin (agent
        // markdown links open in the system browser instead).
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
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
            commands::respond_question,
            commands::end_session,
            commands::get_terminal_output,
            commands::list_custom_commands,
            commands::open_external,
            commands::open_path,
            commands::save_pasted_image,
            provider_probe::probe_provider,
            sign_in::open_provider_login,
            git::git_status,
            git::git_log,
            git::git_remote_url,
            git::git_list_files,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_branches,
            git::git_checkout,
            git::git_push,
            git::git_pull,
            git::git_fetch,
            commands::load_workspace,
            commands::save_workspace,
            history_file::save_session,
            history_file::list_sessions,
            history_file::load_session,
            history_file::delete_session,
            history_file::list_session_stats,
            billing_log::read_billed_usage,
            mcp_probe::probe_mcp_server,
        ])
        .build(tauri::generate_context!())
        .expect("error while running mota-editor")
        .run(|app, event| {
            // Kill agent subprocesses on the way out. `kill_on_drop` is
            // the fallback, but drops are not guaranteed at process exit
            // — an explicit shutdown is. (Windows caveat: TerminateProcess
            // reaches the direct child only; an `npx` shim's node
            // grandchild can outlive it. A job object would close that —
            // deliberate follow-up.)
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                app.state::<AcpSessions>().shutdown_all();
            }
        });
}
