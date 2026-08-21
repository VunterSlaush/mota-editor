//! Reading a project's files off the disk, for the folders git cannot
//! describe.
//!
//! `git_list_files` is the listing everywhere it works: it already knows
//! what `.gitignore` names, so nothing here has to. This module covers the
//! project that was never a repository, where the alternative is showing
//! the user an empty tree of their own files.

use std::path::Path;

use agent_core::vcs::MAX_PROJECT_FILES;

use crate::commands::run_blocking;

/// Folders skipped whole. The same names `worktree::OPAQUE_FOLDERS` refuses
/// to look inside, and for the same reason: they hold machine-generated
/// files by the hundred thousand, and nobody browses them. In a repository
/// `.gitignore` retires this list; here it is all there is.
const SKIPPED_FOLDERS: &[&str] =
    &[".git", "node_modules", "target", "dist", "build", "vendor", ".venv", "venv"];

/// Deep enough for any source tree, shallow enough that a pathological
/// folder cannot walk forever.
const MAX_DEPTH: usize = 24;

/// Every file under a project folder, repo-relative with forward slashes
/// and sorted, for the Files panel when git has nothing to say.
#[tauri::command]
pub async fn list_folder_files(project_path: String) -> Result<Vec<String>, String> {
    if !Path::new(&project_path).is_absolute() {
        return Err("Project path must be absolute.".to_owned());
    }
    run_blocking(move || Ok(walk_files(Path::new(&project_path)))).await
}

fn walk_files(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut level = vec![String::new()];
    for _ in 0..MAX_DEPTH {
        if level.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for parent in &level {
            if read_level(root, parent, &mut found, &mut next) {
                found.sort();
                return found;
            }
        }
        level = next;
    }
    found.sort();
    found
}

/// One directory's entries: files onto `found`, sub-folders onto `next`.
/// Returns true once the cap is reached and the walk should stop.
fn read_level(
    root: &Path,
    parent: &str,
    found: &mut Vec<String>,
    next: &mut Vec<String>,
) -> bool {
    let dir = if parent.is_empty() { root.to_path_buf() } else { root.join(parent) };
    // An unreadable folder is a normal state — a permission the user does
    // not have is not a reason to fail the whole listing.
    let Ok(children) = std::fs::read_dir(&dir) else { return false };
    for child in children.flatten() {
        // `file_type` does not follow links, so a symlinked folder is
        // neither descended into nor able to make the walk loop.
        let Ok(kind) = child.file_type() else { continue };
        let name = child.file_name().to_string_lossy().to_string();
        let relative = if parent.is_empty() { name.clone() } else { format!("{parent}/{name}") };
        if kind.is_dir() {
            if !SKIPPED_FOLDERS.contains(&name.as_str()) {
                next.push(relative);
            }
        } else if kind.is_file() {
            found.push(relative);
            if found.len() >= MAX_PROJECT_FILES {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, relative: &str) {
        let path = root.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "x").unwrap();
    }

    #[test]
    fn lists_files_at_every_depth_as_relative_forward_slash_paths() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "README.md");
        write(dir.path(), "src/ui/App.tsx");

        assert_eq!(walk_files(dir.path()), vec!["README.md", "src/ui/App.tsx"]);
    }

    #[test]
    fn folders_are_not_listed_only_the_files_in_them() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "src/main.rs");

        assert_eq!(walk_files(dir.path()), vec!["src/main.rs"]);
    }

    #[test]
    fn machine_generated_folders_are_skipped_whole() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "app.ts");
        write(dir.path(), "node_modules/left-pad/index.js");
        write(dir.path(), ".git/HEAD");
        write(dir.path(), "target/debug/app");

        assert_eq!(walk_files(dir.path()), vec!["app.ts"]);
    }

    #[test]
    fn an_empty_folder_lists_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(walk_files(dir.path()).is_empty());
    }

    #[test]
    fn a_folder_that_is_not_there_lists_nothing_rather_than_failing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(walk_files(&dir.path().join("gone")).is_empty());
    }

    #[tokio::test]
    async fn a_relative_project_path_is_refused() {
        assert!(list_folder_files("./somewhere".to_owned()).await.is_err());
    }
}
