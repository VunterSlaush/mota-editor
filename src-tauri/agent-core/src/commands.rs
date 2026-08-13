//! Custom slash-command parsing — pure functions over file contents.
//! The shell scans the filesystem; this module only interprets what it
//! finds (name from the file name, description from the content).

/// `/name` derived from a command file's name (`review.md` → `/review`).
pub fn command_name_from_file(file_name: &str) -> Option<String> {
    let stem = file_name.rsplit_once('.').map_or(file_name, |(stem, _)| stem);
    let trimmed = stem.trim();
    (!trimmed.is_empty()).then(|| format!("/{trimmed}"))
}

/// Description of a Markdown command file: the `description:` field of a
/// YAML frontmatter block when present, otherwise the first content line.
pub fn markdown_description(content: &str) -> Option<String> {
    frontmatter_description(content)
        .or_else(|| first_content_line(content))
        .map(|d| tidy(&d))
}

/// Description of a TOML command file (Gemini): its `description = "..."`.
pub fn toml_description(content: &str) -> Option<String> {
    content.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        if key.trim() != "description" {
            return None;
        }
        Some(tidy(value.trim().trim_matches(['"', '\''])))
    })
}

fn frontmatter_description(content: &str) -> Option<String> {
    let rest = content.strip_prefix("---")?;
    let (frontmatter, _) = rest.split_once("---")?;
    frontmatter.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.trim() == "description").then(|| value.trim().trim_matches('"').to_owned())
    })
}

fn first_content_line(content: &str) -> Option<String> {
    content
        .lines()
        .map(|l| l.trim().trim_start_matches('#').trim())
        .find(|l| !l.is_empty())
        .map(str::to_owned)
}

/// Stable fingerprint of a command file's content (FNV-1a, hex). Kept
/// with an approved optimization so the settings screen can flag the
/// row when the markdown moved on; strong enough for change detection,
/// no crypto crate needed for it.
pub fn content_hash(content: &str) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = OFFSET;
    for byte in content.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:016x}")
}

/// The analysis prompt for distilling a command into a script. Asks for
/// exactly one fenced JSON verdict; the frontend entity parses it. Kept
/// here (pure, tested) so the shell only ever assembles a TurnRequest.
pub fn optimize_prompt(command_name: &str, body: &str) -> String {
    format!(
        "You are analyzing the slash command `{command_name}` of an AI coding \
assistant. Its full instructions are between the <command> tags below. Decide \
whether it is DETERMINISTIC: a fixed sequence of shell steps that plays out the \
same way every run, with no judgment beyond filling in a small value.

If it is deterministic, distill it into ONE portable POSIX sh script:
- Only commands the instructions themselves call for; no interactive prompts, \
no AI calls, no steps the instructions do not describe.
- Fail fast: chain steps with `&&` or `set -e`, so a failing step stops the run \
with a non-zero exit.
- Where a single value genuinely needs judgment at run time (a commit message, \
a branch name), leave a `{{{{placeholder}}}}` hole instead of declining.

If MOST of it is deterministic but some steps need judgment too large for a \
placeholder value (writing prose, reading output and deciding), it is PARTIALLY \
optimizable: return the script for the deterministic part plus `instructions` — \
the judgment steps rewritten as concise prompt instructions that say when to run \
the script. Instructions replace the whole command file at run time, so they \
must stand alone; keep them a fraction of its size or the optimization saves \
nothing.

Only when the command is judgment through and through — or it references files \
you cannot see here — is it NOT optimizable. Say why in one sentence, and list \
EVERY blocking instruction as a blocker: quote the offending part briefly, and \
advise how the user could rewrite the command so it stops blocking — remove the \
step, reduce its judgment to a `{{{{placeholder}}}}` value, or split it into a \
command of its own. The user will edit the command file with your advice and \
try again.

Reply with exactly one fenced JSON block and nothing else:

```json
{{\"optimizable\": true, \"script\": \"<the sh script>\", \"instructions\": \"<omit when the script covers everything; else the judgment steps as standalone prompt instructions>\", \"summary\": \"<one line, what it does>\"}}
```

or

```json
{{\"optimizable\": false, \"reason\": \"<one sentence>\", \"blockers\": [{{\"quote\": \"<the blocking instruction, briefly>\", \"advice\": \"<how to change the command so this stops blocking>\"}}]}}
```

<command>
{body}
</command>"
    )
}

fn tidy(description: &str) -> String {
    const MAX: usize = 80;
    let one_line = description.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= MAX {
        one_line
    } else {
        let cut: String = one_line.chars().take(MAX).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_comes_from_the_file_stem() {
        assert_eq!(command_name_from_file("review.md").as_deref(), Some("/review"));
        assert_eq!(command_name_from_file("fix-issue.toml").as_deref(), Some("/fix-issue"));
        assert_eq!(command_name_from_file(".md"), None);
    }

    #[test]
    fn frontmatter_description_wins_over_body() {
        let content = "---\ndescription: Fix a GitHub issue\n---\n# Something else\n";
        assert_eq!(markdown_description(content).as_deref(), Some("Fix a GitHub issue"));
    }

    #[test]
    fn first_line_is_the_fallback_description() {
        let content = "\n# Review this PR carefully\nmore text";
        assert_eq!(
            markdown_description(content).as_deref(),
            Some("Review this PR carefully")
        );
    }

    #[test]
    fn toml_description_is_extracted() {
        let content = "prompt = \"...\"\ndescription = \"Plan a feature\"\n";
        assert_eq!(toml_description(content).as_deref(), Some("Plan a feature"));
    }

    #[test]
    fn content_hash_is_stable_and_content_sensitive() {
        assert_eq!(content_hash("git push"), content_hash("git push"));
        assert_ne!(content_hash("git push"), content_hash("git pull"));
        assert_eq!(content_hash("").len(), 16);
    }

    #[test]
    fn optimize_prompt_carries_the_contract_and_the_body() {
        let prompt = optimize_prompt("/commit-push", "Run npm test, then push.");
        assert!(prompt.contains("`/commit-push`"));
        assert!(prompt.contains("Run npm test, then push."));
        assert!(prompt.contains("\"optimizable\": true"));
        assert!(prompt.contains("\"optimizable\": false"));
        assert!(prompt.contains("\"blockers\""));
        assert!(prompt.contains("\"instructions\""));
        assert!(prompt.contains("PARTIALLY"));
        assert!(prompt.contains("{{placeholder}}"));
        assert!(prompt.contains("POSIX sh"));
    }

    #[test]
    fn long_descriptions_are_truncated_to_one_tidy_line() {
        let long = format!("---\ndescription: {}\n---", "word ".repeat(40));
        let description = markdown_description(&long).unwrap();
        assert!(description.chars().count() <= 81);
        assert!(!description.contains('\n'));
    }
}
