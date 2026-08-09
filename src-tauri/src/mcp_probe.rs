//! Ask a configured MCP server what tools it offers, and what carrying
//! them costs on every request.
//!
//! The I/O shell for [`agent_core::mcp`]: spawn the server exactly as a
//! session would, run the handshake, count, and kill it. Deliberately
//! on-demand rather than automatic — this starts a real process the user
//! configured, and doing that behind their back every time a settings
//! screen opens would be its own kind of rude.

use std::process::Stdio;
use std::time::Duration;

use agent_core::mcp::{self, ToolInventory};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::runner;

/// A server that answers at all answers quickly; one that does not is
/// broken or waiting on something the user must fix.
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

const INITIALIZE_ID: i64 = 1;
const TOOLS_ID: i64 = 2;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeArgs {
    pub command: String,
    pub args: Vec<String>,
    pub env: std::collections::HashMap<String, String>,
}

/// Tool count and prefix cost for one server, or an error to show on its
/// row. Never `Err`: a server that will not start is a fact about that
/// server, not a failure of the screen showing it.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub inventory: Option<ToolInventory>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn probe_mcp_server(args: ProbeArgs) -> Result<ProbeResult, String> {
    match tokio::time::timeout(PROBE_TIMEOUT, inventory_of(&args)).await {
        Ok(Ok(inventory)) => Ok(ProbeResult { inventory: Some(inventory), error: None }),
        Ok(Err(message)) => Ok(ProbeResult { inventory: None, error: Some(message) }),
        Err(_) => Ok(ProbeResult {
            inventory: None,
            error: Some("The server did not answer in time.".to_owned()),
        }),
    }
}

/// Spawn, handshake, count. The child is killed on drop, including on
/// every early return below.
async fn inventory_of(args: &ProbeArgs) -> Result<ToolInventory, String> {
    if runner::resolve_program(&args.command).is_none() {
        return Err(format!("`{}` is not on your PATH.", args.command));
    }
    let mut command = runner::os_command(&args.command, &args.args);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for (key, value) in &args.env {
        command.env(key, value);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("The server took no input.")?;
    let stdout = child.stdout.take().ok_or("The server produced no output.")?;
    let mut lines = BufReader::new(stdout).lines();

    write(&mut stdin, &mcp::initialize_request(INITIALIZE_ID)).await?;
    read_response(&mut lines, INITIALIZE_ID).await?;
    write(&mut stdin, &mcp::initialized_notification()).await?;
    write(&mut stdin, &mcp::tools_list_request(TOOLS_ID)).await?;
    let response = read_response(&mut lines, TOOLS_ID).await?;

    mcp::parse_tools_list(&response).ok_or_else(|| "The server listed no tools.".to_owned())
}

async fn write(stdin: &mut tokio::process::ChildStdin, request: &str) -> Result<(), String> {
    stdin.write_all(request.as_bytes()).await.map_err(|e| e.to_string())
}

/// The response to `id`, skipping the notifications and log lines servers
/// interleave freely.
async fn read_response<R>(
    lines: &mut tokio::io::Lines<BufReader<R>>,
    id: i64,
) -> Result<Value, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
            continue; // servers log freely on stdout; not our problem
        };
        if mcp::is_response_to(&message, id) {
            return Ok(message);
        }
    }
    Err("The server closed before answering.".to_owned())
}
