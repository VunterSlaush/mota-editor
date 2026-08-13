//! Shell crate (Frameworks & Drivers layer) — wires Tauri to the
//! `agent-core` domain. Contains only glue: command handlers, the
//! process runner, and workspace persistence.

mod acp_session;
mod app_badge;
mod billing_log;
mod command_discovery;
mod commands;
mod extension_discovery;
mod extension_host;
mod fs_confine;
mod mcp_probe;
mod git;
mod history_file;
mod provider_probe;
mod runner;
mod session_index;
mod shell_env;
mod shell_history;
mod shell_session;
mod sign_in;
mod terminal;
mod workspace_file;
mod worktree;

use acp_session::AcpSessions;
use commands::RunningTurns;
use extension_host::ExtensionHost;
use shell_session::ShellSessions;

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
        .manage(worktree::Provisioning::default())
        .manage(ShellSessions::default())
        .manage(ExtensionHost::default())
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
            app_badge::set_app_badge,
            commands::open_external,
            commands::open_path,
            commands::save_pasted_image,
            provider_probe::probe_provider,
            sign_in::open_provider_login,
            git::git_status,
            git::git_log,
            git::git_remote_url,
            git::git_current_branch,
            git::git_list_files,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_branches,
            git::git_upstream,
            git::git_checkout,
            git::git_push,
            git::git_pull,
            git::git_fetch,
            git::git_worktree_list,
            git::git_worktree_add,
            git::git_worktree_remove,
            git::git_worktree_prune,
            git::git_branches_merged,
            worktree::worktree_provision,
            worktree::worktree_unprovision,
            worktree::worktree_supports_cow,
            worktree::worktree_disk_usage,
            worktree::worktree_folder_candidates,
            shell_history::shell_history,
            shell_session::shell_open,
            shell_session::shell_write,
            shell_session::shell_resize,
            shell_session::shell_close,
            shell_session::shell_close_project,
            commands::load_workspace,
            commands::save_workspace,
            history_file::save_session,
            history_file::list_sessions,
            history_file::load_session,
            history_file::delete_session,
            history_file::list_session_stats,
            billing_log::read_billed_usage,
            session_index::list_external_sessions,
            mcp_probe::probe_mcp_server,
            extension_host::extensions_list,
            extension_host::extension_enable,
            extension_host::extension_disable,
            extension_host::extension_invoke_command,
            extension_host::extension_publish_event,
            extension_host::extension_respond,
            extension_host::extension_read_log,
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
                app.state::<ExtensionHost>().shutdown_all();
                // The user's terminals too — a shell tree survives the
                // window closing unless it is felled deliberately.
                app.state::<ShellSessions>().kill_all();
            }
        });
}
