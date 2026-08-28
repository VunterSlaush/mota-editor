//! Reading a project's files off the disk.
//!
//! This is the listing, for a repository and a plain folder alike. Git can
//! answer the question and once did, but `git ls-files --exclude-standard`
//! answers it with `.gitignore` applied — no `.env`, nothing under `dist/` —
//! and those are files people open a tree to find. See ADR-0017.

use std::path::Path;

use crate::commands::run_blocking;

/// A project bigger than this is fine; the composer's "@" menu shows fifty
/// rows, so the rest would only cost bandwidth crossing to the UI.
const MAX_PROJECT_FILES: usize = 20_000;

/// Folders skipped whole: they hold machine-generated files by the hundred
/// thousand, and nobody browses them. Now that this list is the only ignore
/// rule the tree has, it covers more than `worktree::OPAQUE_FOLDERS` — the
/// tail of it is what `.gitignore` used to hide for us, and the names have
/// to be common enough to be worth stating for every project.
const SKIPPED_FOLDERS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    ".venv",
    "venv",
    ".next",
    ".turbo",
    "coverage",
    "__pycache__",
];

/// Deep enough for any source tree, shallow enough that a pathological
/// folder cannot walk forever.
const MAX_DEPTH: usize = 24;

/// Every file under a project folder, project-relative with forward
/// slashes and sorted, for the Files panel and the composer's "@" menu.
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
        write(dir.path(), ".next/static/chunk.js");
        write(dir.path(), "coverage/index.html");

        assert_eq!(walk_files(dir.path()), vec!["app.ts"]);
    }

    // The reason this walk exists: git would have hidden both of these.
    #[test]
    fn an_ignored_dotfile_is_listed_like_any_other() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), ".env");
        write(dir.path(), ".env.local");
        write(dir.path(), "app.ts");

        assert_eq!(walk_files(dir.path()), vec![".env", ".env.local", "app.ts"]);
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
