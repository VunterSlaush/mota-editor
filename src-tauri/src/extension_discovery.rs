//! Extension discovery — walks the well-known extension folders and
//! parses each `mota-extension.json`. Filesystem I/O lives here (shell
//! layer); manifest interpretation is `agent_core::extension`'s.

use std::fs;
use std::path::{Path, PathBuf};

use agent_core::extension::{parse_manifest, ExtensionManifest, ManifestError};
use tauri::{AppHandle, Manager};

pub const MANIFEST_FILE: &str = "mota-extension.json";

/// Whether an extension folder lives in a project or the user's home —
/// project-origin extensions arrive with a cloned repo and get an extra
/// warning at consent time.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionOrigin {
    Project,
    User,
}

/// One extension folder as found on disk — manifest parsed or not, so
/// the settings screen can show authors their mistakes instead of
/// silently dropping the folder.
pub struct DiscoveredExtension {
    /// The folder name — the id for valid manifests (enforced equal),
    /// the only handle we have for broken ones.
    pub dir_name: String,
    pub dir: PathBuf,
    pub origin: ExtensionOrigin,
    /// The project the extension came with, for project-origin ones.
    pub project_path: Option<String>,
    pub manifest: Result<ExtensionManifest, ManifestError>,
}

/// Scan every extension folder, project dirs before the user dir; on an
/// id clash the first wins (same stable-dedup posture as command
/// discovery) and the loser is simply not listed twice.
pub fn discover(app: &AppHandle, project_paths: &[String]) -> Vec<DiscoveredExtension> {
    let mut found: Vec<DiscoveredExtension> = Vec::new();
    for project in project_paths {
        let dir = Path::new(project).join(".mota").join("extensions");
        collect_from_dir(&dir, ExtensionOrigin::Project, Some(project.clone()), &mut found);
    }
    if let Ok(home) = app.path().home_dir() {
        let dir = home.join(".mota").join("extensions");
        collect_from_dir(&dir, ExtensionOrigin::User, None, &mut found);
    }
    found.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    found.dedup_by(|a, b| a.dir_name == b.dir_name);
    found
}

fn collect_from_dir(
    dir: &Path,
    origin: ExtensionOrigin,
    project_path: Option<String>,
    found: &mut Vec<DiscoveredExtension>,
) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let ext_dir = entry.path();
        if !ext_dir.is_dir() {
            continue;
        }
        let Some(dir_name) = ext_dir.file_name().and_then(|n| n.to_str()).map(str::to_owned)
        else {
            continue;
        };
        let Ok(text) = fs::read_to_string(ext_dir.join(MANIFEST_FILE)) else {
            continue; // A folder without a manifest is not an extension.
        };
        let manifest = parse_manifest(&text).and_then(|manifest| {
            // The id joins settings keys and data paths — it must be the
            // folder the user actually inspected, not whatever the
            // manifest claims.
            if manifest.name == dir_name {
                Ok(manifest)
            } else {
                Err(ManifestError::Invalid(format!(
                    "Manifest name \"{}\" must match the folder name \"{dir_name}\"",
                    manifest.name
                )))
            }
        });
        found.push(DiscoveredExtension {
            dir_name,
            dir: ext_dir,
            origin,
            project_path: project_path.clone(),
            manifest,
        });
    }
}

/// Read a prompt-command template file from inside the extension folder.
/// The manifest validator already rejected traversal textually; this
/// canonicalizes and re-checks, because textual checks are advice and
/// the filesystem is the law.
pub fn read_prompt_file(ext_dir: &Path, relative: &str) -> Result<String, String> {
    let root = fs::canonicalize(ext_dir).map_err(|e| format!("Extension folder unavailable: {e}"))?;
    let file = fs::canonicalize(ext_dir.join(relative))
        .map_err(|e| format!("Could not resolve {relative}: {e}"))?;
    if !file.starts_with(&root) {
        return Err(format!("Command file is outside the extension: {relative}"));
    }
    fs::read_to_string(&file).map_err(|e| format!("Could not read {relative}: {e}"))
}
