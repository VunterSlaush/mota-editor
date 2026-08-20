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

/// One boundary group an agent proposed: a name a person would
/// recognise, and the folders it writes in.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SuggestedBoundary {
    pub name: String,
    pub boundaries: Vec<String>,
}

/// How many groups a suggestion run ever returns. A monorepo has a
/// handful of real areas; a list longer than this is the model padding,
/// and the user has to read every row it produces.
pub const SUGGESTION_LIMIT: usize = 12;

/// What to ask an agent for, given the folders the project actually has.
/// The folder list is included so the answer names real paths instead of
/// the model's idea of a typical repository.
pub fn boundary_suggestion_prompt(folders: &[String]) -> String {
    let listing = folders
        .iter()
        .map(|f| format!("- {f}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Group this project's folders into the areas someone would scope a task to \
         — a frontend app, a backend service, a shared library, the docs.\n\n\
         These are the project's folders:\n{listing}\n\n\
         Read whatever configuration you need (workspace manifests, build files) to \
         tell real areas apart from incidental folders. Then reply with ONLY a JSON \
         array, no prose and no code fence, of at most {SUGGESTION_LIMIT} objects:\n\
         [{{\"name\": \"Frontend\", \"boundaries\": [\"apps/web\", \"packages/ui\"]}}]\n\n\
         Rules: every path must be one of the folders listed above or a folder \
         inside one; paths are relative to the project root, use forward slashes, \
         and never start with '/', a drive letter, '..' or '.git'. Leave out \
         dependency and build-output folders — nobody scopes a task to those. \
         Give each group a short human name."
    )
}

/// The suggestions in an agent's reply, or an empty list when it did not
/// answer in the shape it was asked for. Tolerant of a code fence and of
/// prose around the array, because models add both; strict about the
/// paths, because these become write permissions — anything absolute or
/// escaping is dropped rather than shown to the user as an option.
pub fn parse_boundary_suggestions(reply: &str) -> Vec<SuggestedBoundary> {
    let Some(array) = json_array(reply) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(array) else {
        return Vec::new();
    };
    let Some(items) = parsed.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(suggestion_from)
        .take(SUGGESTION_LIMIT)
        .collect()
}

fn suggestion_from(item: &serde_json::Value) -> Option<SuggestedBoundary> {
    let name = item.get("name").and_then(serde_json::Value::as_str)?.trim();
    let boundaries: Vec<String> = item
        .get("boundaries")
        .and_then(serde_json::Value::as_array)?
        .iter()
        .filter_map(serde_json::Value::as_str)
        .map(normalize_boundary)
        .filter(|path| valid_boundary(path))
        .collect();
    // A group with no usable folder is not a group. Neither is a nameless
    // one — the user picks these by name.
    (!name.is_empty() && !boundaries.is_empty()).then(|| SuggestedBoundary {
        name: name.to_owned(),
        boundaries,
    })
}

/// The outermost `[...]` in a reply, fence and prose ignored.
fn json_array(reply: &str) -> Option<&str> {
    let start = reply.find('[')?;
    let end = reply.rfind(']')?;
    (end > start).then(|| &reply[start..=end])
}

fn normalize_boundary(path: &str) -> String {
    path.trim().replace('\\', "/").trim_end_matches('/').to_owned()
}

/// Whether a suggested path is one we would let a user grant writes to.
/// Mirrors the frontend's `boundaryPathProblem`; a suggestion is
/// untrusted input like any other model output.
pub fn valid_boundary(path: &str) -> bool {
    if path.is_empty() || path.starts_with('/') {
        return false;
    }
    // A drive letter ("C:/work") is absolute too.
    if path.chars().nth(1) == Some(':') {
        return false;
    }
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    !segments.is_empty() && !segments.contains(&"..") && segments.first() != Some(&".git")
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
    fn the_suggestion_prompt_names_the_projects_own_folders() {
        let prompt = boundary_suggestion_prompt(&["apps/web".to_owned(), "libs".to_owned()]);
        assert!(prompt.contains("- apps/web"));
        assert!(prompt.contains("- libs"));
        assert!(prompt.contains("JSON array"));
    }

    #[test]
    fn parses_a_plain_json_array() {
        let reply = r#"[{"name":"Frontend","boundaries":["apps/web","packages/ui"]}]"#;
        assert_eq!(
            parse_boundary_suggestions(reply),
            vec![SuggestedBoundary {
                name: "Frontend".to_owned(),
                boundaries: vec!["apps/web".to_owned(), "packages/ui".to_owned()],
            }]
        );
    }

    #[test]
    fn parses_through_a_code_fence_and_surrounding_prose() {
        let reply = "Sure! Here you go:\n```json\n[{\"name\":\"API\",\"boundaries\":[\"services/api\"]}]\n```\nHope that helps.";
        let parsed = parse_boundary_suggestions(reply);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].name, "API");
    }

    #[test]
    fn drops_paths_that_would_escape_the_project() {
        let reply = r#"[{"name":"Bad","boundaries":["../secrets","/etc","C:/windows",".git/hooks","apps/web"]}]"#;
        let parsed = parse_boundary_suggestions(reply);
        // The one good path survives; nothing absolute or escaping does.
        assert_eq!(parsed[0].boundaries, vec!["apps/web".to_owned()]);
    }

    #[test]
    fn drops_a_group_with_no_usable_folder_or_no_name() {
        let reply = r#"[{"name":"Bad","boundaries":["/etc"]},{"name":"","boundaries":["src"]}]"#;
        assert_eq!(parse_boundary_suggestions(reply), Vec::new());
    }

    #[test]
    fn normalizes_separators_and_trailing_slashes() {
        let reply = r#"[{"name":"UI","boundaries":["apps\\web\\"]}]"#;
        assert_eq!(parse_boundary_suggestions(reply)[0].boundaries, vec!["apps/web".to_owned()]);
    }

    #[test]
    fn a_reply_in_the_wrong_shape_yields_nothing_rather_than_erroring() {
        assert_eq!(parse_boundary_suggestions("I could not determine that."), Vec::new());
        assert_eq!(parse_boundary_suggestions("[not json"), Vec::new());
        assert_eq!(parse_boundary_suggestions(r#"{"name":"x"}"#), Vec::new());
    }

    #[test]
    fn caps_a_model_that_pads_the_list() {
        let items: Vec<String> = (0..40)
            .map(|n| format!(r#"{{"name":"G{n}","boundaries":["src/{n}"]}}"#))
            .collect();
        let reply = format!("[{}]", items.join(","));
        assert_eq!(parse_boundary_suggestions(&reply).len(), SUGGESTION_LIMIT);
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
