//! Extension host — spawns and talks to extension processes over the
//! Mota Extension Protocol (MXP, see ADR-0012). All protocol logic lives
//! in `agent_core::extension`; this file is mechanical: spawn, route,
//! broker, respond. Modeled on `acp_session.rs`.
//!
//! It is also the ONLY owner of the permission grant table
//! (`extensions.json` in the app-config dir): the webview can ask for an
//! extension to be enabled but can never supply the permission list —
//! consent happens in a native dialog against the manifest on disk.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::io::Write as _;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use agent_core::extension::{
    self, CommandKind, ExtensionManifest, ManifestError, Permission, PromptSource,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::oneshot;

use crate::extension_discovery::{self, DiscoveredExtension, ExtensionOrigin};
use crate::runner;
use crate::workspace_file;

const INIT_TIMEOUT: Duration = Duration::from_secs(10);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const IDLE_TIMEOUT_DEFAULT: Duration = Duration::from_secs(5 * 60);
const IDLE_TIMEOUT_MAX: Duration = Duration::from_secs(30 * 60);
const IDLE_POLL: Duration = Duration::from_secs(30);
/// This many crashes inside the window quarantines the extension until
/// the user re-enables it — no proactive restart loops.
const CRASH_LIMIT: usize = 3;
const CRASH_WINDOW: Duration = Duration::from_secs(60);
const STDERR_TAIL_LINES: usize = 200;
/// Workbench events the frontend may fan out. The whitelist is the
/// extension point for Phase 2's event catalog.
const EVENT_WHITELIST: [&str; 4] =
    ["turn/completed", "project/opened", "project/closed", "app/started"];

pub const EVENT_CHANNEL: &str = "extension-event";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WireEvent<'a> {
    extension_id: &'a str,
    event: &'a extension::ExtensionUiEvent,
}

fn emit(app: &AppHandle, extension_id: &str, event: &extension::ExtensionUiEvent) {
    let _ = app.emit(EVENT_CHANNEL, WireEvent { extension_id, event });
}

// ---- Managed state ----

/// A discovered extension with a valid manifest, cached by
/// `extensions_list` so enable/invoke can find it by id alone.
struct Registered {
    dir: PathBuf,
    origin: ExtensionOrigin,
    project_path: Option<String>,
    manifest: ExtensionManifest,
}

#[derive(Default)]
pub struct ExtensionHost {
    registry: Mutex<HashMap<String, Arc<Registered>>>,
    processes: Mutex<HashMap<String, Arc<ExtensionProcess>>>,
    /// Per-extension boot serialization — two triggers arriving at once
    /// must share one spawn (same trick as `AcpSessions::booting`).
    booting: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    crashes: Mutex<HashMap<String, VecDeque<Instant>>>,
    quarantined: Mutex<HashSet<String>>,
}

impl ExtensionHost {
    fn registered(&self, id: &str) -> Option<Arc<Registered>> {
        self.registry.lock().unwrap_or_else(PoisonError::into_inner).get(id).cloned()
    }

    fn process(&self, id: &str) -> Option<Arc<ExtensionProcess>> {
        self.processes.lock().unwrap_or_else(PoisonError::into_inner).get(id).cloned()
    }

    fn boot_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(
            self.booting
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entry(id.to_owned())
                .or_default(),
        )
    }

    /// Evict only if the map still holds THIS process — a respawn may
    /// already have replaced it under the same id.
    fn evict(&self, id: &str, process: &Arc<ExtensionProcess>) {
        let mut map = self.processes.lock().unwrap_or_else(PoisonError::into_inner);
        if map.get(id).is_some_and(|p| Arc::ptr_eq(p, process)) {
            map.remove(id);
        }
    }

    fn is_quarantined(&self, id: &str) -> bool {
        self.quarantined.lock().unwrap_or_else(PoisonError::into_inner).contains(id)
    }

    fn clear_quarantine(&self, id: &str) {
        self.quarantined.lock().unwrap_or_else(PoisonError::into_inner).remove(id);
        self.crashes.lock().unwrap_or_else(PoisonError::into_inner).remove(id);
    }

    /// Record one crash; returns true when the extension just crossed
    /// the quarantine threshold.
    fn record_crash(&self, id: &str) -> bool {
        let now = Instant::now();
        let mut crashes = self.crashes.lock().unwrap_or_else(PoisonError::into_inner);
        let window = crashes.entry(id.to_owned()).or_default();
        window.push_back(now);
        while window
            .front()
            .is_some_and(|t| now.duration_since(*t) > CRASH_WINDOW)
        {
            window.pop_front();
        }
        if window.len() >= CRASH_LIMIT {
            self.quarantined
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(id.to_owned());
            true
        } else {
            false
        }
    }

    /// App exit: kill every extension process deliberately.
    pub fn shutdown_all(&self) {
        for (_, process) in
            self.processes.lock().unwrap_or_else(PoisonError::into_inner).drain()
        {
            process.shutdown();
        }
    }
}

pub struct ExtensionProcess {
    id: String,
    granted: Vec<Permission>,
    subscribed: Vec<String>,
    child: Mutex<Option<Child>>,
    stdin: tokio::sync::Mutex<ChildStdin>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>,
    /// Extension-request ids forwarded to the frontend (`host/notify`)
    /// and awaiting `extension_respond` — the webview may only answer
    /// ids that are actually outstanding.
    outstanding_ui: Mutex<HashSet<i64>>,
    dead: AtomicBool,
    last_activity: Mutex<Instant>,
    stderr_tail: Mutex<VecDeque<String>>,
}

impl ExtensionProcess {
    fn request_id(&self) -> i64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    fn touch(&self) {
        *self.last_activity.lock().unwrap_or_else(PoisonError::into_inner) = Instant::now();
    }

    fn idle_for(&self) -> Duration {
        self.last_activity
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .elapsed()
    }

    fn stderr_tail_text(&self) -> String {
        let tail = self.stderr_tail.lock().unwrap_or_else(PoisonError::into_inner);
        tail.iter().cloned().collect::<Vec<_>>().join("\n")
    }

    async fn write_message(&self, message: &Value) -> Result<(), String> {
        let mut line = message.to_string();
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("Could not write to the extension: {e}"))
    }

    async fn call(&self, message: Value, id: i64) -> Result<Value, String> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap_or_else(PoisonError::into_inner).insert(id, tx);
        self.write_message(&message).await?;
        rx.await
            .unwrap_or_else(|_| Err("The extension ended before responding.".to_owned()))
    }

    async fn call_with_timeout(
        &self,
        message: Value,
        id: i64,
        timeout: Duration,
    ) -> Result<Value, String> {
        tokio::time::timeout(timeout, self.call(message, id))
            .await
            .unwrap_or_else(|_| {
                self.pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&id);
                Err("The extension did not respond in time.".to_owned())
            })
    }

    fn shutdown(&self) {
        self.dead.store(true, Ordering::SeqCst);
        for (_, tx) in self.pending.lock().unwrap_or_else(PoisonError::into_inner).drain() {
            let _ = tx.send(Err("Extension stopped.".to_owned()));
        }
        if let Some(mut child) =
            self.child.lock().unwrap_or_else(PoisonError::into_inner).take()
        {
            let _ = child.start_kill();
        }
    }

    /// Polite version for idle shutdown: ask first, kill after a grace
    /// period. `shutdown` remains the fallback everywhere else.
    async fn shutdown_graceful(&self) {
        let _ = self.write_message(&extension::shutdown_notification()).await;
        tokio::time::sleep(Duration::from_secs(3)).await;
        self.shutdown();
    }
}

// ---- The grant table (extensions.json) ----

#[derive(Serialize, Deserialize, Default)]
struct GrantFile {
    grants: HashMap<String, Grant>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Grant {
    enabled: bool,
    /// The exact permission strings the user approved, sorted. A
    /// manifest whose permission set no longer matches goes back to
    /// needs-approval — never silently widened.
    permissions: Vec<String>,
    granted_at_epoch_s: u64,
}

fn grants_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("extensions.json"))
}

fn load_grants(app: &AppHandle) -> GrantFile {
    let Ok(path) = grants_path(app) else {
        return GrantFile::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save_grants(app: &AppHandle, grants: &GrantFile) -> Result<(), String> {
    let path = grants_path(app)?;
    let json = serde_json::to_string_pretty(grants).map_err(|e| e.to_string())?;
    workspace_file::write_atomic(&path, json.as_bytes()).map_err(|e| e.to_string())
}

fn permission_strings(manifest: &ExtensionManifest) -> Vec<String> {
    let mut strings: Vec<String> =
        manifest.permissions.iter().map(|p| p.as_str().to_owned()).collect();
    strings.sort();
    strings
}

fn grant_matches(grant: &Grant, manifest: &ExtensionManifest) -> bool {
    grant.permissions == permission_strings(manifest)
}

// ---- Wire descriptors for the frontend ----

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommandWire {
    pub name: String,
    pub description: String,
    pub args_hint: Option<String>,
    /// "prompt" | "programmatic"
    pub kind: String,
    /// The expansion text, resolved here (template inline or file read)
    /// so the frontend can expand prompt commands synchronously.
    pub template: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpServerWire {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PanelWire {
    pub id: String,
    pub title: String,
    pub icon: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionDescriptorWire {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub origin: ExtensionOrigin,
    pub project_path: Option<String>,
    pub path: String,
    pub permissions: Vec<String>,
    /// needs-approval | disabled | enabled | running | crashed |
    /// invalid | incompatible
    pub status: String,
    pub error: Option<String>,
    pub commands: Vec<CommandWire>,
    pub mcp_servers: Vec<McpServerWire>,
    pub panels: Vec<PanelWire>,
    pub events: Vec<String>,
}

fn describe(
    host: &ExtensionHost,
    grants: &GrantFile,
    found: &DiscoveredExtension,
) -> ExtensionDescriptorWire {
    let mut base = ExtensionDescriptorWire {
        id: found.dir_name.clone(),
        display_name: found.dir_name.clone(),
        version: String::new(),
        description: String::new(),
        origin: found.origin,
        project_path: found.project_path.clone(),
        path: found.dir.to_string_lossy().into_owned(),
        permissions: Vec::new(),
        status: "invalid".to_owned(),
        error: None,
        commands: Vec::new(),
        mcp_servers: Vec::new(),
        panels: Vec::new(),
        events: Vec::new(),
    };
    let manifest = match &found.manifest {
        Err(ManifestError::Invalid(message)) => {
            base.error = Some(message.clone());
            return base;
        }
        Err(ManifestError::Incompatible(message)) => {
            base.status = "incompatible".to_owned();
            base.error = Some(message.clone());
            return base;
        }
        Ok(manifest) => manifest,
    };

    base.display_name = manifest.display_name.clone();
    base.version = manifest.version.clone();
    base.description = manifest.description.clone();
    base.permissions = permission_strings(manifest);
    base.events = manifest.events.clone();
    for command in &manifest.commands {
        let (kind, template) = match &command.kind {
            CommandKind::Programmatic => ("programmatic", None),
            CommandKind::Prompt(PromptSource::Template(template)) => {
                ("prompt", Some(template.clone()))
            }
            CommandKind::Prompt(PromptSource::File(relative)) => {
                match extension_discovery::read_prompt_file(&found.dir, relative) {
                    Ok(text) => ("prompt", Some(text)),
                    Err(message) => {
                        base.error = Some(message);
                        ("prompt", None)
                    }
                }
            }
        };
        base.commands.push(CommandWire {
            name: command.name.clone(),
            description: command.description.clone(),
            args_hint: command.args_hint.clone(),
            kind: kind.to_owned(),
            template,
        });
    }
    for server in &manifest.mcp_servers {
        // The agent spawns MCP servers with the PROJECT as cwd — resolve
        // paths that clearly point into the extension folder so authors
        // can write "./mcp.js" and have it work.
        let command = resolve_in_dir(&found.dir, &server.command);
        let args = server.args.iter().map(|a| resolve_in_dir(&found.dir, a)).collect();
        base.mcp_servers.push(McpServerWire {
            name: server.name.clone(),
            command,
            args,
            env: server.env.iter().cloned().collect(),
        });
    }

    for panel in &manifest.panels {
        base.panels.push(PanelWire {
            id: panel.id.clone(),
            title: panel.title.clone(),
            icon: panel.icon.clone(),
        });
    }

    base.status = match grants.grants.get(&found.dir_name) {
        _ if host.is_quarantined(&found.dir_name) => "crashed".to_owned(),
        None => "needs-approval".to_owned(),
        Some(grant) if !grant_matches(grant, manifest) => "needs-approval".to_owned(),
        Some(grant) if !grant.enabled => "disabled".to_owned(),
        Some(_) => {
            let running = host
                .process(&found.dir_name)
                .is_some_and(|p| !p.dead.load(Ordering::SeqCst));
            if running { "running" } else { "enabled" }.to_owned()
        }
    };
    if base.status == "crashed" {
        let tail =
            host.process(&found.dir_name).map(|p| p.stderr_tail_text()).unwrap_or_default();
        if !tail.is_empty() {
            base.error = Some(tail);
        }
    }
    base
}

/// A manifest value that names a file inside the extension folder
/// becomes that file's absolute path; anything else passes through
/// (a PATH program name, a plain argument).
fn resolve_in_dir(dir: &std::path::Path, value: &str) -> String {
    if value.contains("..") {
        return value.to_owned();
    }
    let candidate = dir.join(value);
    if candidate.is_file() {
        candidate.to_string_lossy().into_owned()
    } else {
        value.to_owned()
    }
}

// ---- Spawning and the reader loop ----

fn log_path(app: &AppHandle, id: &str) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("ext-{id}.log")))
}

fn append_log(app: &AppHandle, id: &str, line: &str) {
    if let Some(path) = log_path(app, id) {
        if let Ok(mut file) =
            std::fs::OpenOptions::new().create(true).append(true).open(path)
        {
            let _ = writeln!(file, "{line}");
        }
    }
}

async fn ensure_process(
    app: &AppHandle,
    host: &ExtensionHost,
    id: &str,
) -> Result<Arc<ExtensionProcess>, String> {
    let registered = host
        .registered(id)
        .ok_or_else(|| format!("Unknown extension: {id}"))?;
    let grants = load_grants(app);
    let enabled = grants
        .grants
        .get(id)
        .is_some_and(|g| g.enabled && grant_matches(g, &registered.manifest));
    if !enabled {
        return Err(format!("Extension {id} is not enabled"));
    }
    if host.is_quarantined(id) {
        return Err(format!(
            "Extension {id} crashed repeatedly and is quarantined — re-enable it in Settings"
        ));
    }

    let boot = host.boot_lock(id);
    let _guard = boot.lock().await;
    if let Some(existing) = host.process(id) {
        if !existing.dead.load(Ordering::SeqCst) {
            return Ok(existing);
        }
        host.evict(id, &existing);
    }

    let entry = registered
        .manifest
        .entry
        .as_ref()
        .ok_or_else(|| format!("Extension {id} has no entry process"))?;
    // The entry command resolves inside the extension folder first (the
    // folder the user approved), then PATH via os_command — never the
    // project cwd.
    let program = resolve_in_dir(&registered.dir, &entry.command);
    let mut command = runner::os_command(&program, &entry.args);
    command
        .current_dir(&registered.dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|e| format!("Could not start {id}: {e}"))?;

    let stdin = child.stdin.take().ok_or("Could not open the extension's stdin")?;
    let stdout = child.stdout.take().ok_or("Could not open the extension's stdout")?;
    let stderr = child.stderr.take();

    let idle_timeout = registered
        .manifest
        .idle_timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(IDLE_TIMEOUT_DEFAULT)
        .min(IDLE_TIMEOUT_MAX);
    let process = Arc::new(ExtensionProcess {
        id: id.to_owned(),
        granted: registered.manifest.permissions.clone(),
        subscribed: registered.manifest.events.clone(),
        child: Mutex::new(Some(child)),
        stdin: tokio::sync::Mutex::new(stdin),
        next_id: AtomicI64::new(1),
        pending: Mutex::new(HashMap::new()),
        outstanding_ui: Mutex::new(HashSet::new()),
        dead: AtomicBool::new(false),
        last_activity: Mutex::new(Instant::now()),
        stderr_tail: Mutex::new(VecDeque::new()),
    });

    if let Some(stderr) = stderr {
        spawn_stderr_reader(app, Arc::clone(&process), stderr);
    }
    spawn_reader(app.clone(), Arc::clone(&process), stdout);

    let data_dir = extension_data_dir(app, id)?;
    let init_id = process.request_id();
    let init = extension::initialize_request(
        init_id,
        id,
        app.package_info().version.to_string().as_str(),
        &registered.manifest.permissions,
        &data_dir,
        &project_paths_for(&registered),
    );
    let result = process
        .call_with_timeout(init, init_id, INIT_TIMEOUT)
        .await
        .map_err(|e| {
            process.shutdown();
            with_stderr(&process, format!("{id} failed to initialize: {e}"))
        })?;
    if !extension::initialize_accepted(&result) {
        process.shutdown();
        return Err(format!("{id} answered initialize with an unsupported protocol version"));
    }

    host.processes
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(id.to_owned(), Arc::clone(&process));
    emit(app, id, &status_event("running", None));

    // Pure command/tool providers hold no subscriptions — reap them when
    // idle. Event subscribers stay resident; killing one would silently
    // drop its reason to exist.
    if process.subscribed.is_empty() {
        spawn_idle_watchdog(app.clone(), Arc::clone(&process), idle_timeout);
    }

    Ok(process)
}

fn project_paths_for(registered: &Registered) -> Vec<String> {
    registered.project_path.clone().into_iter().collect()
}

fn extension_data_dir(app: &AppHandle, id: &str) -> Result<String, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("extensions-data")
        .join(id);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

fn with_stderr(process: &ExtensionProcess, message: String) -> String {
    let tail = process.stderr_tail_text();
    if tail.is_empty() {
        message
    } else {
        format!("{message}\n--- extension stderr ---\n{tail}")
    }
}

fn status_event(status: &str, error: Option<String>) -> extension::ExtensionUiEvent {
    extension::ExtensionUiEvent::StatusChanged { status: status.to_owned(), error }
}

fn spawn_stderr_reader(
    app: &AppHandle,
    process: Arc<ExtensionProcess>,
    stderr: tokio::process::ChildStderr,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            append_log(&app, &process.id, &line);
            let mut tail =
                process.stderr_tail.lock().unwrap_or_else(PoisonError::into_inner);
            if tail.len() >= STDERR_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    });
}

fn spawn_idle_watchdog(app: AppHandle, process: Arc<ExtensionProcess>, idle_timeout: Duration) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(IDLE_POLL).await;
            if process.dead.load(Ordering::SeqCst) {
                return;
            }
            if process.idle_for() >= idle_timeout {
                process.shutdown_graceful().await;
                let host = app.state::<ExtensionHost>();
                host.evict(&process.id, &process);
                emit(&app, &process.id, &status_event("enabled", None));
                return;
            }
        }
    });
}

fn spawn_reader(
    app: AppHandle,
    process: Arc<ExtensionProcess>,
    stdout: tokio::process::ChildStdout,
) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            handle_line(&app, &process, &line).await;
        }
        // Extension process ended. Deliberate shutdowns set `dead`
        // before killing — anything else is a crash.
        let deliberate = process.dead.swap(true, Ordering::SeqCst);
        for (_, tx) in
            process.pending.lock().unwrap_or_else(PoisonError::into_inner).drain()
        {
            let _ = tx.send(Err("The extension ended before responding.".to_owned()));
        }
        let host = app.state::<ExtensionHost>();
        host.evict(&process.id, &process);
        if !deliberate {
            let quarantined = host.record_crash(&process.id);
            let tail = process.stderr_tail_text();
            let error = if tail.is_empty() { None } else { Some(tail) };
            append_log(&app, &process.id, "[host] extension process exited unexpectedly");
            let status = if quarantined { "crashed" } else { "enabled" };
            emit(&app, &process.id, &status_event(status, error));
        }
    });
}

async fn handle_line(app: &AppHandle, process: &Arc<ExtensionProcess>, line: &str) {
    process.touch();
    match extension::classify(line) {
        extension::Incoming::Response { id, result } => {
            if let Some(tx) =
                process.pending.lock().unwrap_or_else(PoisonError::into_inner).remove(&id)
            {
                let _ = tx.send(result);
            }
        }
        extension::Incoming::Request { id, method, params } => {
            broker(app, process, id, &method, params).await;
        }
        extension::Incoming::Notification { method, params } => {
            if method == "host/log" {
                log_from_extension(app, process, &params);
            }
            // Unknown notifications are ignored — drift tolerance.
        }
        extension::Incoming::Malformed => {
            append_log(app, &process.id, &format!("[host] unparseable line: {line}"));
        }
    }
}

fn log_from_extension(app: &AppHandle, process: &ExtensionProcess, params: &Value) {
    let message = params.get("message").and_then(Value::as_str).unwrap_or("");
    if !message.is_empty() {
        append_log(app, &process.id, &format!("[log] {message}"));
    }
}

/// The permission broker — every extension → host request passes here.
/// The decision table is pure (`required_permission`); this only checks
/// the grant and dispatches.
async fn broker(
    app: &AppHandle,
    process: &Arc<ExtensionProcess>,
    id: i64,
    method: &str,
    params: Value,
) {
    let response = match extension::required_permission(method) {
        extension::PermissionCheck::Unknown => {
            Some(extension::method_not_found_response(id, method))
        }
        extension::PermissionCheck::Needs(permission)
            if !process.granted.contains(&permission) =>
        {
            Some(extension::permission_denied_response(id, permission))
        }
        _ => dispatch(app, process, id, method, params).await,
    };
    if let Some(response) = response {
        let _ = process.write_message(&response).await;
    }
}

/// Serve one permitted host-API call. Returning None means the answer
/// arrives later (`host/notify` round-trips through the frontend).
async fn dispatch(
    app: &AppHandle,
    process: &Arc<ExtensionProcess>,
    id: i64,
    method: &str,
    params: Value,
) -> Option<Value> {
    match method {
        "host/log" => {
            log_from_extension(app, process, &params);
            Some(extension::result_response(id, Value::Object(Default::default())))
        }
        "host/notify" => {
            // Fulfilled by the frontend (NotificationPort and its focus
            // suppression live there); answered via `extension_respond`.
            let title = params.get("title").and_then(Value::as_str).unwrap_or("Extension");
            let body = params.get("body").and_then(Value::as_str).unwrap_or("");
            process
                .outstanding_ui
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(id);
            emit(
                app,
                &process.id,
                &extension::ExtensionUiEvent::NotifyRequested {
                    request_id: id.to_string(),
                    title: truncate_chars(title, 200),
                    body: truncate_chars(body, 1000),
                },
            );
            None
        }
        "panels/refresh" => {
            // The webview re-pulls the named panel if it is open — the
            // host never renders view data it did not just ask for.
            let panel_id = params.get("panelId").and_then(Value::as_str).map(str::to_owned);
            emit(app, &process.id, &extension::ExtensionUiEvent::PanelChanged { panel_id });
            Some(extension::result_response(id, Value::Object(Default::default())))
        }
        // Methods in the permission table whose implementation lands in
        // a later phase — an honest error beats a hang.
        _ => Some(extension::internal_error_response(
            id,
            &format!("This host does not implement {method} yet"),
        )),
    }
}

fn truncate_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

// ---- Tauri commands ----

#[tauri::command]
pub async fn extensions_list(
    app: AppHandle,
    host: State<'_, ExtensionHost>,
    project_paths: Vec<String>,
) -> Result<Vec<ExtensionDescriptorWire>, String> {
    let found = extension_discovery::discover(&app, &project_paths);
    let grants = load_grants(&app);
    {
        let mut registry = host.registry.lock().unwrap_or_else(PoisonError::into_inner);
        registry.clear();
        for item in &found {
            if let Ok(manifest) = &item.manifest {
                registry.insert(
                    item.dir_name.clone(),
                    Arc::new(Registered {
                        dir: item.dir.clone(),
                        origin: item.origin,
                        project_path: item.project_path.clone(),
                        manifest: manifest.clone(),
                    }),
                );
            }
        }
    }
    Ok(found.iter().map(|item| describe(&host, &grants, item)).collect())
}

#[tauri::command]
pub async fn extension_enable(
    app: AppHandle,
    host: State<'_, ExtensionHost>,
    id: String,
) -> Result<ExtensionDescriptorWire, String> {
    let registered = host
        .registered(&id)
        .ok_or_else(|| format!("Unknown extension: {id} — reload the extension list"))?;
    // Consent is against the manifest as it exists on disk RIGHT NOW,
    // never against anything the webview supplied.
    let manifest_text =
        std::fs::read_to_string(registered.dir.join(extension_discovery::MANIFEST_FILE))
            .map_err(|e| format!("Could not read the manifest: {e}"))?;
    let manifest = extension::parse_manifest(&manifest_text)
        .map_err(|e| format!("Manifest rejected: {}", e.message()))?;
    if manifest.name != id {
        return Err("Manifest name changed on disk — reload the extension list".to_owned());
    }

    let mut grants = load_grants(&app);
    let already_consented = grants
        .grants
        .get(&id)
        .is_some_and(|grant| grant_matches(grant, &manifest));
    if !already_consented {
        let approved = consent_dialog(&app, &registered, &manifest).await?;
        if !approved {
            return Err("Enable cancelled".to_owned());
        }
    }
    grants.grants.insert(
        id.clone(),
        Grant {
            enabled: true,
            permissions: permission_strings(&manifest),
            granted_at_epoch_s: SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        },
    );
    save_grants(&app, &grants)?;
    host.clear_quarantine(&id);

    // Refresh the registry entry with what we just consented to.
    host.registry.lock().unwrap_or_else(PoisonError::into_inner).insert(
        id.clone(),
        Arc::new(Registered {
            dir: registered.dir.clone(),
            origin: registered.origin,
            project_path: registered.project_path.clone(),
            manifest: manifest.clone(),
        }),
    );

    let found = DiscoveredExtension {
        dir_name: id.clone(),
        dir: registered.dir.clone(),
        origin: registered.origin,
        project_path: registered.project_path.clone(),
        manifest: Ok(manifest),
    };
    Ok(describe(&host, &grants, &found))
}

/// The native consent dialog — the one gate a compromised webview
/// cannot click through.
async fn consent_dialog(
    app: &AppHandle,
    registered: &Registered,
    manifest: &ExtensionManifest,
) -> Result<bool, String> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    let mut lines = vec![format!(
        "Enable \"{}\" v{}?",
        manifest.display_name, manifest.version
    )];
    if !manifest.description.is_empty() {
        lines.push(manifest.description.clone());
    }
    if registered.origin == ExtensionOrigin::Project {
        lines.push(
            "⚠ This extension came with the repository — only enable it if you trust the repo."
                .to_owned(),
        );
    }
    if manifest.permissions.is_empty() {
        lines.push("It requests no permissions.".to_owned());
    } else {
        lines.push("It will be able to:".to_owned());
        for permission in &manifest.permissions {
            let danger = if permission.is_dangerous() { " ⚠" } else { "" };
            lines.push(format!("  • {}{danger}", permission_label(*permission)));
        }
    }
    let message = lines.join("\n");
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .message(message)
            .title("Enable extension")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Enable".to_owned(),
                "Cancel".to_owned(),
            ))
            .blocking_show()
    })
    .await
    .map_err(|e| format!("Consent dialog failed: {e}"))
}

fn permission_label(permission: Permission) -> &'static str {
    match permission {
        Permission::CommandsRegister => "add slash commands to the palette",
        Permission::ToolsRegister => "add MCP tools to your AI agents",
        Permission::EventsSubscribe => "watch workbench events (turns, projects)",
        Permission::Notifications => "show desktop notifications",
        Permission::TranscriptsRead => "read chat transcripts",
        Permission::AgentPrompt => "start agent turns (spends your AI credits)",
        Permission::FsProjectRead => "read files in your open projects",
        Permission::UiPanel => "add a sidebar panel",
        Permission::UiTheme => "add color themes",
        Permission::ShellExec => "run programs with your full user privileges",
        Permission::ProviderRegister => "register a new AI provider",
    }
}

#[tauri::command]
pub async fn extension_disable(
    app: AppHandle,
    host: State<'_, ExtensionHost>,
    id: String,
) -> Result<(), String> {
    let mut grants = load_grants(&app);
    if let Some(grant) = grants.grants.get_mut(&id) {
        grant.enabled = false;
        save_grants(&app, &grants)?;
    }
    if let Some(process) = host.process(&id) {
        process.shutdown();
        host.evict(&id, &process);
    }
    host.clear_quarantine(&id);
    emit(&app, &id, &status_event("disabled", None));
    Ok(())
}

#[tauri::command]
pub async fn extension_invoke_command(
    app: AppHandle,
    host: State<'_, ExtensionHost>,
    extension_id: String,
    command: String,
    args: String,
    tab_id: String,
    project_path: String,
) -> Result<Value, String> {
    let process = ensure_process(&app, &host, &extension_id).await?;
    let id = process.request_id();
    let request =
        extension::command_execute_request(id, &command, &args, &tab_id, &project_path);
    process.touch();
    process.call_with_timeout(request, id, COMMAND_TIMEOUT).await
}

#[tauri::command]
pub async fn extension_panel_load(
    app: AppHandle,
    host: State<'_, ExtensionHost>,
    extension_id: String,
    panel_id: String,
    tab_id: String,
    project_path: String,
) -> Result<Value, String> {
    let process = ensure_process(&app, &host, &extension_id).await?;
    let id = process.request_id();
    let request = extension::panel_load_request(id, &panel_id, &tab_id, &project_path);
    process.touch();
    process.call_with_timeout(request, id, COMMAND_TIMEOUT).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri commands are flat by nature.
pub async fn extension_panel_action(
    app: AppHandle,
    host: State<'_, ExtensionHost>,
    extension_id: String,
    panel_id: String,
    action: String,
    item_id: String,
    value: Option<String>,
    tab_id: String,
    project_path: String,
) -> Result<Value, String> {
    let process = ensure_process(&app, &host, &extension_id).await?;
    let id = process.request_id();
    let action = extension::PanelAction { action, item_id, value };
    let request =
        extension::panel_action_request(id, &panel_id, &action, &tab_id, &project_path);
    process.touch();
    process.call_with_timeout(request, id, COMMAND_TIMEOUT).await
}

#[tauri::command]
pub async fn extension_publish_event(
    app: AppHandle,
    host: State<'_, ExtensionHost>,
    event: String,
    payload: Value,
) -> Result<(), String> {
    if !EVENT_WHITELIST.contains(&event.as_str()) {
        return Err(format!("Unknown workbench event: {event}"));
    }
    let subscribers: Vec<String> = {
        let registry = host.registry.lock().unwrap_or_else(PoisonError::into_inner);
        registry
            .iter()
            .filter(|(_, r)| r.manifest.events.iter().any(|e| e == &event))
            .map(|(id, _)| id.clone())
            .collect()
    };
    let notification = extension::event_emit_notification(&event, &payload);
    for id in subscribers {
        // Lazy activation: the first matching event boots the process.
        // A subscriber that is not enabled simply doesn't get events.
        match ensure_process(&app, &host, &id).await {
            Ok(process) => {
                process.touch();
                let _ = process.write_message(&notification).await;
            }
            Err(message) => append_log(&app, &id, &format!("[host] event not delivered: {message}")),
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn extension_respond(
    host: State<'_, ExtensionHost>,
    extension_id: String,
    request_id: String,
    result: Value,
) -> Result<(), String> {
    let process = host
        .process(&extension_id)
        .ok_or_else(|| format!("Extension {extension_id} is not running"))?;
    let id: i64 = request_id.parse().map_err(|_| "Bad request id".to_owned())?;
    let known = process
        .outstanding_ui
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&id);
    if !known {
        return Err("No such outstanding request".to_owned());
    }
    process.write_message(&extension::result_response(id, result)).await
}

#[tauri::command]
pub async fn extension_read_log(app: AppHandle, extension_id: String) -> Result<String, String> {
    if !agent_core::extension::is_valid_id(&extension_id) {
        return Err("Bad extension id".to_owned());
    }
    let Some(path) = log_path(&app, &extension_id) else {
        return Ok(String::new());
    };
    match std::fs::read_to_string(path) {
        // The tail is what debugging needs; the file can grow for months.
        Ok(text) => Ok(tail_chars(&text, 32 * 1024)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn tail_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    text.chars().skip(text.chars().count() - max).collect()
}
