//! Subtask scope — the authority a scoped tab grants its agent, and the
//! pure decisions the drivers enforce with it. Mirrors `extension.rs`'s
//! discipline: a closed vocabulary, decision tables with no I/O, and
//! failing closed wherever the answer is unclear.

use serde::Deserialize;

use crate::turn::Permission;

/// The wire shape matches the frontend entity: `{"access":"read-only"}`
/// or `{"access":"boundary","boundaries":["apps/web"]}`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "access", rename_all = "kebab-case")]
pub enum SubtaskScope {
    ReadOnly,
    Boundary {
        /// Project-relative folders the agent may write inside.
        #[serde(default)]
        boundaries: Vec<String>,
    },
}

/// Whether a write at `rel_path` (relative to the project root, already
/// canonicalized by the caller) is inside this scope. No scope means an
/// ordinary tab: everything inside the project is writable, exactly as
/// before. Matching is by whole path segments — `apps/web` never admits
/// `apps/web-admin` — and case-insensitive with either separator,
/// because the dominant platform's filesystems are.
pub fn write_allowed(scope: Option<&SubtaskScope>, rel_path: &str) -> bool {
    match scope {
        None => true,
        Some(SubtaskScope::ReadOnly) => false,
        Some(SubtaskScope::Boundary { boundaries }) => {
            let path = segments(rel_path);
            boundaries.iter().any(|b| {
                let boundary = segments(b);
                !boundary.is_empty() && path.len() > boundary.len() && path.starts_with(&boundary)
            })
        }
    }
}

fn segments(path: &str) -> Vec<String> {
    path.split(['/', '\\'])
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// The permission tier the scope leaves standing. A read-only subtask
/// never auto-approves anything — every action the agent still asks for
/// is one the user should see. A boundary subtask keeps auto but never
/// the vendor bypass flag: bypass switches off the very sandbox that
/// backs the boundary up.
pub fn effective_permission(permission: Permission, scope: Option<&SubtaskScope>) -> Permission {
    match scope {
        None => permission,
        Some(SubtaskScope::ReadOnly) => Permission::Manual,
        Some(SubtaskScope::Boundary { .. }) => match permission {
            Permission::Bypass => Permission::Auto,
            other => other,
        },
    }
}

/// The agent-defined session mode that mechanically enforces this scope
/// over ACP, where one exists. Only codex has a read-only sandbox mode;
/// a boundary has no native equivalent anywhere — the client-fs guard
/// and the preamble carry it. Mirrors `acp::native_mode_id`.
pub fn native_scope_mode_id(provider_id: &str, scope: Option<&SubtaskScope>) -> Option<&'static str> {
    match (provider_id, scope) {
        ("codex", Some(SubtaskScope::ReadOnly)) => Some("read-only"),
        _ => None,
    }
}

/// The advisory layer: what every provider is told about its scope, even
/// where nothing mechanical backs it up. Vendor CLIs own their tools, so
/// this is the one instruction that reaches all of them.
pub fn scope_preamble(scope: Option<&SubtaskScope>) -> Option<String> {
    match scope {
        None => None,
        Some(SubtaskScope::ReadOnly) => Some(
            "This is a READ-ONLY subtask. You may read files in this project, but you \
             must not create, modify, or delete any file, and you must not run commands \
             that change state. Answer, analyze, and explain only."
                .to_owned(),
        ),
        Some(SubtaskScope::Boundary { boundaries }) => Some(format!(
            "This subtask is limited to part of the project. You may read anywhere in \
             the project, but you must only create, modify, or delete files inside these \
             folders:\n{}",
            boundaries
                .iter()
                .map(|b| format!("- {b}"))
                .collect::<Vec<_>>()
                .join("\n")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boundary(folders: &[&str]) -> SubtaskScope {
        SubtaskScope::Boundary {
            boundaries: folders.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    #[test]
    fn no_scope_allows_every_write() {
        assert!(write_allowed(None, "anything/at/all.rs"));
    }

    #[test]
    fn read_only_allows_no_write() {
        assert!(!write_allowed(Some(&SubtaskScope::ReadOnly), "notes.md"));
    }

    #[test]
    fn boundary_admits_writes_inside_and_refuses_outside() {
        let scope = boundary(&["apps/web"]);
        assert!(write_allowed(Some(&scope), "apps/web/index.ts"));
        assert!(write_allowed(Some(&scope), "apps/web/deep/nested/file.ts"));
        assert!(!write_allowed(Some(&scope), "apps/api/main.rs"));
        assert!(!write_allowed(Some(&scope), "README.md"));
    }

    #[test]
    fn boundary_matches_whole_segments_not_string_prefixes() {
        let scope = boundary(&["apps/web"]);
        assert!(!write_allowed(Some(&scope), "apps/web-admin/index.ts"));
    }

    #[test]
    fn the_boundary_folder_itself_is_not_a_writable_file() {
        // `apps/web` names a folder; a write must target something IN it.
        let scope = boundary(&["apps/web"]);
        assert!(!write_allowed(Some(&scope), "apps/web"));
    }

    #[test]
    fn boundary_is_case_insensitive_and_separator_agnostic() {
        let scope = boundary(&["Apps\\Web"]);
        assert!(write_allowed(Some(&scope), "apps/web/File.ts"));
        assert!(write_allowed(Some(&scope), "APPS\\WEB\\file.ts"));
    }

    #[test]
    fn an_empty_boundary_list_admits_nothing() {
        // Fail closed: a boundary subtask that lost its folders is
        // read-only in effect, never unrestricted.
        let scope = boundary(&[]);
        assert!(!write_allowed(Some(&scope), "apps/web/index.ts"));
    }

    #[test]
    fn an_empty_boundary_entry_admits_nothing() {
        let scope = boundary(&["", "/"]);
        assert!(!write_allowed(Some(&scope), "apps/web/index.ts"));
    }

    #[test]
    fn read_only_forces_manual_permission() {
        let scope = SubtaskScope::ReadOnly;
        assert_eq!(
            effective_permission(Permission::Bypass, Some(&scope)),
            Permission::Manual
        );
        assert_eq!(
            effective_permission(Permission::Auto, Some(&scope)),
            Permission::Manual
        );
    }

    #[test]
    fn boundary_caps_bypass_to_auto_and_leaves_the_rest() {
        let scope = boundary(&["apps/web"]);
        assert_eq!(
            effective_permission(Permission::Bypass, Some(&scope)),
            Permission::Auto
        );
        assert_eq!(
            effective_permission(Permission::Auto, Some(&scope)),
            Permission::Auto
        );
        assert_eq!(
            effective_permission(Permission::Manual, Some(&scope)),
            Permission::Manual
        );
    }

    #[test]
    fn no_scope_leaves_permission_alone() {
        assert_eq!(effective_permission(Permission::Bypass, None), Permission::Bypass);
    }

    #[test]
    fn preambles_say_what_the_scope_means() {
        assert!(scope_preamble(None).is_none());
        assert!(scope_preamble(Some(&SubtaskScope::ReadOnly))
            .unwrap()
            .contains("READ-ONLY"));
        let text = scope_preamble(Some(&boundary(&["apps/web", "libs/ui"]))).unwrap();
        assert!(text.contains("- apps/web"));
        assert!(text.contains("- libs/ui"));
    }

    #[test]
    fn only_codex_has_a_native_read_only_mode() {
        assert_eq!(
            native_scope_mode_id("codex", Some(&SubtaskScope::ReadOnly)),
            Some("read-only")
        );
        assert_eq!(native_scope_mode_id("claude", Some(&SubtaskScope::ReadOnly)), None);
        assert_eq!(native_scope_mode_id("codex", Some(&boundary(&["apps/web"]))), None);
        assert_eq!(native_scope_mode_id("codex", None), None);
    }

    #[test]
    fn deserializes_the_frontend_wire_shape() {
        assert_eq!(
            serde_json::from_str::<SubtaskScope>(r#"{"access":"read-only"}"#).unwrap(),
            SubtaskScope::ReadOnly
        );
        assert_eq!(
            serde_json::from_str::<SubtaskScope>(
                r#"{"access":"boundary","boundaries":["apps/web"]}"#
            )
            .unwrap(),
            boundary(&["apps/web"])
        );
    }
}
