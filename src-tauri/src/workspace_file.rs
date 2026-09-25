//! Workspace persistence — one JSON file in the OS app-config directory.
//! The backend treats the payload as opaque; its shape is owned by the
//! frontend core (`PersistedWorkspace`).

use std::fs;
use std::io;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "workspace.json";

fn workspace_path(app: &AppHandle) -> io::Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| io::Error::other(e.to_string()))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(FILE_NAME))
}

pub fn load(app: &AppHandle) -> io::Result<Option<String>> {
    let path = workspace_path(app)?;
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn save(app: &AppHandle, json: &str) -> io::Result<()> {
    let path = workspace_path(app)?;
    write_atomic(&path, json.as_bytes())
}

/// Write via a fresh temp file + atomic rename. `create_new` refuses to
/// write through anything pre-planted at the temp path (a symlink would
/// redirect the write), and a crash mid-write can never truncate the
/// real file.
pub(crate) fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> io::Result<()> {
    replace_via_temp(path, bytes, |tmp| {
        fs::OpenOptions::new().write(true).create_new(true).open(tmp)
    })
}

/// [`write_atomic`] for a secret: the file is owner-only (0600 on Unix)
/// from the moment it exists, never widened after the fact. Windows
/// relies on the per-user ACL of the app-config folder.
pub(crate) fn write_atomic_private(path: &std::path::Path, bytes: &[u8]) -> io::Result<()> {
    replace_via_temp(path, bytes, create_private)
}

/// A new, owner-only file. `create_new`, so nothing pre-planted at the
/// path (a symlink) is ever written through.
pub(crate) fn create_private(path: &std::path::Path) -> io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn replace_via_temp(
    path: &std::path::Path,
    bytes: &[u8],
    create: impl FnOnce(&std::path::Path) -> io::Result<fs::File>,
) -> io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let _ = fs::remove_file(&tmp);
    let mut file = create(&tmp)?;
    let result = file.write_all(bytes);
    drop(file);
    match result.and_then(|()| fs::rename(&tmp, path)) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}
