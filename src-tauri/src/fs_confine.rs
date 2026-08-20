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

/// Resolve an agent-supplied WRITE target against the session's subtask
/// scope. The confinement runs first, so `..` and symlinks are already
/// defeated by the time the scope judges the project-relative remainder;
/// the judgment itself is `agent_core::scope::write_allowed`, pure and
/// unit-tested. No scope behaves exactly like `confine_to_project`.
pub fn confine_write_to_scope(
    project_path: &str,
    requested: &str,
    scope: Option<&agent_core::SubtaskScope>,
) -> Result<std::path::PathBuf, String> {
    if matches!(scope, Some(agent_core::SubtaskScope::ReadOnly)) {
        return Err("This subtask is read-only.".to_owned());
    }
    let file = confine_to_project(project_path, requested, false)?;
    if scope.is_none() {
        return Ok(file);
    }
    let project = std::fs::canonicalize(project_path)
        .map_err(|e| format!("Project folder unavailable: {e}"))?;
    let rel = file
        .strip_prefix(&project)
        .map_err(|_| format!("Path is outside the project: {requested}"))?;
    if agent_core::scope::write_allowed(scope, &rel.to_string_lossy()) {
        Ok(file)
    } else {
        Err(format!("Path is outside this subtask's writable folders: {requested}"))
    }
}

#[cfg(test)]
mod tests {
    use super::{confine_to_project, confine_write_to_scope};
    use agent_core::SubtaskScope;

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

    /// A project with a writable `apps/web` boundary and a file target,
    /// ready to be judged.
    fn scoped_write(
        target: &[&str],
    ) -> (tempfile::TempDir, String, SubtaskScope) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("apps").join("web")).unwrap();
        std::fs::create_dir_all(dir.path().join("apps").join("api")).unwrap();
        let mut requested = dir.path().to_path_buf();
        for part in target {
            requested.push(part);
        }
        let scope = SubtaskScope::Boundary { boundaries: vec!["apps/web".to_owned()] };
        (dir, requested.to_string_lossy().into_owned(), scope)
    }

    #[test]
    fn a_read_only_scope_refuses_every_write() {
        let dir = tempfile::tempdir().unwrap();
        let requested = dir.path().join("new.md");
        let err = confine_write_to_scope(
            dir.path().to_str().unwrap(),
            requested.to_str().unwrap(),
            Some(&SubtaskScope::ReadOnly),
        );
        assert_eq!(err.unwrap_err(), "This subtask is read-only.");
    }

    #[test]
    fn no_scope_writes_exactly_as_before() {
        let dir = tempfile::tempdir().unwrap();
        let requested = dir.path().join("new.md");
        let ok = confine_write_to_scope(
            dir.path().to_str().unwrap(),
            requested.to_str().unwrap(),
            None,
        );
        assert!(ok.is_ok());
    }

    #[test]
    fn a_boundary_scope_admits_a_write_inside_its_folder() {
        let (dir, requested, scope) = scoped_write(&["apps", "web", "new.ts"]);
        let ok = confine_write_to_scope(dir.path().to_str().unwrap(), &requested, Some(&scope));
        assert!(ok.is_ok());
    }

    #[test]
    fn a_boundary_scope_refuses_a_write_outside_its_folder() {
        let (dir, requested, scope) = scoped_write(&["apps", "api", "new.rs"]);
        let err = confine_write_to_scope(dir.path().to_str().unwrap(), &requested, Some(&scope));
        assert!(err.unwrap_err().contains("writable folders"));
    }

    #[test]
    fn a_boundary_scope_still_refuses_leaving_the_project() {
        let (dir, _, scope) = scoped_write(&[]);
        let outside = tempfile::tempdir().unwrap();
        let requested = outside.path().join("escape.md");
        let err = confine_write_to_scope(
            dir.path().to_str().unwrap(),
            requested.to_str().unwrap(),
            Some(&scope),
        );
        assert!(err.is_err());
    }
}
