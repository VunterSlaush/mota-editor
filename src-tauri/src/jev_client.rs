//! Jev over HTTPS, through the system `curl` (ADR-0025).
//!
//! The shell half of [`agent_core::jev`]: where the API key lives, and the
//! one process spawn that carries a request. There is no HTTP crate in
//! this app, and one endpoint does not justify a TLS stack — `curl` ships
//! with every supported OS (Windows 10+ included), the way `git` does for
//! ADR-0007.
//!
//! The key never touches argv and never reaches the webview: it lives in
//! a curl config file (`-K`) that only this module writes, owner-only.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use agent_core::jev::{self, Answers};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::io::AsyncWriteExt;

use crate::runner;
use crate::workspace_file;

/// `<app_config_dir>/jev-key.curlrc`, holding one curl header directive.
pub const KEY_FILE: &str = "jev-key.curlrc";
pub const ENDPOINT: &str = "https://api.typesafe.ai/v1/systemone";

/// The fallback when no key was saved in Settings.
const ENV_KEY: &str = "TYPESAFE_API_KEY";

/// Jev answers in 70–500 ms; past four seconds something is wrong, and an
/// approval is waiting on it.
const CURL_MAX_TIME: Duration = Duration::from_secs(4);

/// Our own ceiling above curl's, for a curl that never exits.
const HARD_TIMEOUT: Duration = Duration::from_secs(5);

const MAX_KEY_BYTES: usize = 512;

/// curl's exit code for "operation timed out".
const CURL_TIMED_OUT: i32 = 28;

/// Whether Jev can be called, for the settings screen. Never the key.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyStatus {
    pub configured: bool,
    /// `file` (saved in Settings), `env` (TYPESAFE_API_KEY), or `none`.
    pub source: String,
    pub curl_found: bool,
}

/// Why a Jev call produced no answers. Every one of these means "carry on
/// as if Jev were not enabled" to the gate.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JevFailure {
    Unconfigured,
    Unavailable { message: String },
    Timeout,
    Auth,
    Validation { message: String },
    RateLimited,
    Overloaded,
    Malformed { message: String },
}

pub fn key_status(app: &AppHandle) -> KeyStatus {
    let source = if saved_key_path(app).is_some() {
        "file"
    } else if env_key().is_some() {
        "env"
    } else {
        "none"
    };
    KeyStatus {
        configured: source != "none",
        source: source.to_owned(),
        curl_found: runner::resolve_program("curl").is_some(),
    }
}

/// Save the key where only this module reads it. Refused unless it is a
/// plain token: the file is a curl config, and a quote or a newline in it
/// would let the "key" add options of its own to every request.
pub fn set_api_key(app: &AppHandle, key: &str) -> Result<(), String> {
    let key = key.trim();
    validate_key(key)?;
    let dir = config_dir(app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create the settings folder: {e}"))?;
    workspace_file::write_atomic_private(&dir.join(KEY_FILE), key_file_line(key).as_bytes())
        .map_err(|e| format!("Could not save the Jev key: {e}"))
}

pub fn clear_api_key(app: &AppHandle) -> Result<(), String> {
    let path = config_dir(app)?.join(KEY_FILE);
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not remove the Jev key: {e}")),
    }
}

/// Whether a key is on hand, without spawning anything — asked on every
/// permission request, so it has to cost nothing.
pub fn is_configured_fast(app: &AppHandle) -> bool {
    saved_key_path(app).is_some() || env_key().is_some()
}

/// Ask Jev `questions` about `state`. One request, no retries: the gate
/// has an agent waiting on it, and a failure already has a safe meaning.
pub async fn classify(app: &AppHandle, state: Value, questions: Value) -> Result<Answers, JevFailure> {
    let credential = credential(app)?;
    let body = jev::systemone_request(state, questions).to_string();
    let (status, text) = post_systemone(credential.path(), body.as_bytes()).await?;
    answers_from(status, &text)
}

/// The one spawn: POST `body` with the key from `key_file`, and return the
/// HTTP status and response body.
async fn post_systemone(key_file: &Path, body: &[u8]) -> Result<(u16, String), JevFailure> {
    if runner::resolve_program("curl").is_none() {
        return Err(JevFailure::Unavailable { message: "curl was not found on your PATH.".to_owned() });
    }
    let mut command = runner::os_command("curl", &curl_args(key_file));
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| JevFailure::Unavailable { message: format!("Could not start curl: {e}") })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| JevFailure::Unavailable { message: "curl took no input.".to_owned() })?;
    let exchange = async move {
        stdin.write_all(body).await?;
        // curl reads `@-` to end of file; the request is not sent until
        // stdin closes.
        drop(stdin);
        child.wait_with_output().await
    };
    // A timeout drops the exchange, and the child with it (kill_on_drop).
    let output = tokio::time::timeout(HARD_TIMEOUT, exchange)
        .await
        .map_err(|_| JevFailure::Timeout)?
        .map_err(|e| JevFailure::Unavailable { message: format!("curl failed: {e}") })?;
    if output.status.code() == Some(CURL_TIMED_OUT) {
        return Err(JevFailure::Timeout);
    }
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(JevFailure::Unavailable { message: format!("curl: {stderr}") });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let (status, text) = split_status(&stdout).ok_or_else(|| JevFailure::Malformed {
        message: "curl reported no HTTP status.".to_owned(),
    })?;
    Ok((status, text.to_owned()))
}

/// Works on every curl since 7.55 (the Windows 10 baseline): no
/// `--fail-with-body`, and the status rides on the last stdout line.
fn curl_args(key_file: &Path) -> Vec<String> {
    let seconds = |d: Duration| d.as_secs().to_string();
    vec![
        "-sS".to_owned(),
        "-X".to_owned(),
        "POST".to_owned(),
        ENDPOINT.to_owned(),
        "-H".to_owned(),
        "Content-Type: application/json".to_owned(),
        "-K".to_owned(),
        key_file.to_string_lossy().into_owned(),
        "--data-binary".to_owned(),
        "@-".to_owned(),
        "--max-time".to_owned(),
        seconds(CURL_MAX_TIME),
        "--connect-timeout".to_owned(),
        "2".to_owned(),
        "-w".to_owned(),
        "\\n%{http_code}".to_owned(),
    ]
}

/// `-w "\n%{http_code}"` puts the status on a line of its own after the
/// body; the body itself may hold newlines, so the LAST line is the one.
fn split_status(stdout: &str) -> Option<(u16, &str)> {
    let (body, status) = stdout.trim_end_matches(['\r', '\n']).rsplit_once('\n')?;
    Some((status.trim().parse().ok()?, body))
}

fn answers_from(status: u16, body: &str) -> Result<Answers, JevFailure> {
    match status {
        200 => {
            let value: Value = serde_json::from_str(body)
                .map_err(|e| JevFailure::Malformed { message: format!("Jev's reply was not JSON: {e}") })?;
            jev::parse_answers(&value).map_err(|message| JevFailure::Malformed { message })
        }
        401 => Err(JevFailure::Auth),
        422 => Err(JevFailure::Validation { message: jev::http_failure(status, body) }),
        429 => Err(JevFailure::RateLimited),
        529 => Err(JevFailure::Overloaded),
        other => Err(JevFailure::Malformed { message: jev::http_failure(other, body) }),
    }
}

/// Where the key for this request comes from: the saved file, or a
/// per-call copy of the environment variable (removed when dropped).
enum Credential {
    Saved(PathBuf),
    FromEnv(TemporaryKeyFile),
}

impl Credential {
    fn path(&self) -> &Path {
        match self {
            Credential::Saved(path) => path,
            Credential::FromEnv(file) => &file.0,
        }
    }
}

fn credential(app: &AppHandle) -> Result<Credential, JevFailure> {
    if let Some(path) = saved_key_path(app) {
        return Ok(Credential::Saved(path));
    }
    let key = env_key().ok_or(JevFailure::Unconfigured)?;
    let dir = config_dir(app)
        .map_err(|message| JevFailure::Unavailable { message })?
        .join("jev");
    TemporaryKeyFile::write(&dir, &key)
        .map(Credential::FromEnv)
        .map_err(|e| JevFailure::Unavailable { message: format!("Could not stage the Jev key: {e}") })
}

/// The environment key materialised as a curl config for one request.
/// curl older than 8.3 cannot read an environment variable itself, and
/// the key must not go on argv (every process listing would show it).
struct TemporaryKeyFile(PathBuf);

impl TemporaryKeyFile {
    fn write(dir: &Path, key: &str) -> std::io::Result<Self> {
        use std::io::Write as _;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::fs::create_dir_all(dir)?;
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = dir.join(format!("env-key.{}-{n}", std::process::id()));
        let guard = TemporaryKeyFile(path);
        let mut file = workspace_file::create_private(&guard.0)?;
        file.write_all(key_file_line(key).as_bytes())?;
        Ok(guard)
    }
}

impl Drop for TemporaryKeyFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|e| format!("Could not find the settings folder: {e}"))
}

fn saved_key_path(app: &AppHandle) -> Option<PathBuf> {
    let path = config_dir(app).ok()?.join(KEY_FILE);
    path.is_file().then_some(path)
}

/// The environment key, when it is one a curl config can carry safely.
fn env_key() -> Option<String> {
    let key = std::env::var(ENV_KEY).ok()?;
    let key = key.trim();
    validate_key(key).ok()?;
    Some(key.to_owned())
}

/// A key is a plain token. Anything else is refused rather than escaped:
/// curl config files have their own quoting rules, and a newline would
/// start a new option.
fn validate_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err("The Jev key is empty.".to_owned());
    }
    if key.len() > MAX_KEY_BYTES {
        return Err("That is too long to be a Jev key.".to_owned());
    }
    let plain = key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '+' | '/' | '=' | '-'));
    if plain {
        Ok(())
    } else {
        Err("A Jev key holds only letters, digits and . _ ~ + / = -".to_owned())
    }
}

fn key_file_line(key: &str) -> String {
    format!("header = \"Authorization: Bearer {key}\"\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_status_is_the_last_line() {
        assert_eq!(split_status("{\"a\":1}\n200"), Some((200, "{\"a\":1}")));
        assert_eq!(split_status("line one\nline two\n401"), Some((401, "line one\nline two")));
        assert_eq!(split_status("\n204"), Some((204, "")));
        assert_eq!(split_status("no status"), None);
    }

    #[test]
    fn a_key_that_could_inject_curl_options_is_refused() {
        assert!(validate_key("sk_live.ABC-123_x~y+z/=").is_ok());
        assert!(validate_key("abc\n--output /tmp/x").is_err());
        assert!(validate_key("abc\"def").is_err());
        assert!(validate_key("abc def").is_err());
        assert!(validate_key("").is_err());
        assert!(validate_key(&"a".repeat(MAX_KEY_BYTES + 1)).is_err());
    }

    #[test]
    fn the_key_file_is_one_curl_header_directive() {
        assert_eq!(key_file_line("tok"), "header = \"Authorization: Bearer tok\"\n");
    }

    #[test]
    fn the_key_file_path_travels_as_a_config_never_the_key_itself() {
        let args = curl_args(Path::new("/cfg/jev-key.curlrc"));
        let at = args.iter().position(|a| a == "-K").unwrap();
        assert_eq!(args[at + 1], "/cfg/jev-key.curlrc");
        assert!(!args.iter().any(|a| a.contains("Bearer")));
    }

    #[test]
    fn statuses_become_failures_the_gate_can_fall_back_on() {
        assert_eq!(answers_from(401, ""), Err(JevFailure::Auth));
        assert_eq!(answers_from(429, ""), Err(JevFailure::RateLimited));
        assert_eq!(answers_from(529, ""), Err(JevFailure::Overloaded));
        assert!(matches!(answers_from(422, "bad"), Err(JevFailure::Validation { .. })));
        assert!(matches!(answers_from(200, "not json"), Err(JevFailure::Malformed { .. })));
    }

    #[test]
    fn a_200_reply_becomes_answers() {
        let body = r#"{"model":"jev-1.13.0","answers":{"k":{"type":"noul","noul":0.2}},"usage":{"input_tokens":1,"output_tokens":1}}"#;
        assert_eq!(answers_from(200, body).unwrap().answers.len(), 1);
    }

    #[test]
    fn a_temporary_key_file_is_removed_when_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let file = TemporaryKeyFile::write(dir.path(), "tok").unwrap();
        let path = file.0.clone();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), key_file_line("tok"));
        drop(file);
        assert!(!path.exists());
    }

    #[test]
    fn failures_cross_the_wire_tagged_by_kind() {
        let wire = serde_json::to_value(JevFailure::RateLimited).unwrap();
        assert_eq!(wire, serde_json::json!({"kind": "rateLimited"}));
    }
}
