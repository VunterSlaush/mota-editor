//! Shared path-confinement helper (Frameworks & Drivers layer). Used by
//! every driver that honors a file path supplied by an outside process —
//! ACP agents (`acp_session`) and extensions (`extension_host`) — so the
//! confinement rule cannot drift between them.

/// Resolve an externally-supplied path and require it inside the project.
/// Canonicalizes real paths so `..` and symlinks cannot escape; for a
/// write to a not-yet-existing file the PARENT directory must exist and
/// be inside instead (create the file, not directories).
pub fn confine_to_project(
    project_path: &str,
    requested: &str,
    must_exist: bool,
) -> Result<std::path::PathBuf, String> {
    let project = std::fs::canonicalize(project_path)
        .map_err(|e| format!("Project folder unavailable: {e}"))?;
    match std::fs::canonicalize(requested) {
        Ok(file) => {
            if file.starts_with(&project) {
                Ok(file)
            } else {
                Err(format!("Path is outside the project: {requested}"))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !must_exist => {
            let path = std::path::Path::new(requested);
            let parent = path
                .parent()
                .ok_or_else(|| format!("Path has no parent directory: {requested}"))?;
            let file_name = path
                .file_name()
                .ok_or_else(|| format!("Path names no file: {requested}"))?;
            let parent = std::fs::canonicalize(parent)
                .map_err(|e| format!("Parent directory unavailable: {e}"))?;
            if parent.starts_with(&project) {
                Ok(parent.join(file_name))
            } else {
                Err(format!("Path is outside the project: {requested}"))
            }
        }
        Err(e) => Err(format!("Could not resolve {requested}: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::confine_to_project;

    #[test]
    fn accepts_a_file_inside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.md");
        std::fs::write(&file, "x").unwrap();
        let ok = confine_to_project(dir.path().to_str().unwrap(), file.to_str().unwrap(), true);
        assert!(ok.is_ok());
    }

    #[test]
    fn rejects_a_path_outside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let file = other.path().join("escape.md");
        std::fs::write(&file, "x").unwrap();
        let err = confine_to_project(dir.path().to_str().unwrap(), file.to_str().unwrap(), true);
        assert!(err.is_err());
    }

    #[test]
    fn rejects_dot_dot_escape_for_new_files() {
        let dir = tempfile::tempdir().unwrap();
        let requested = dir.path().join("..").join("new.md");
        let err = confine_to_project(
            dir.path().to_str().unwrap(),
            requested.to_str().unwrap(),
            false,
        );
        assert!(err.is_err());
    }

    #[test]
    fn accepts_a_new_file_whose_parent_is_inside() {
        let dir = tempfile::tempdir().unwrap();
        let requested = dir.path().join("new.md");
        let ok = confine_to_project(
            dir.path().to_str().unwrap(),
            requested.to_str().unwrap(),
            false,
        );
        assert!(ok.is_ok());
    }
}
