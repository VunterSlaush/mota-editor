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
    fn long_descriptions_are_truncated_to_one_tidy_line() {
        let long = format!("---\ndescription: {}\n---", "word ".repeat(40));
        let description = markdown_description(&long).unwrap();
        assert!(description.chars().count() <= 81);
        assert!(!description.contains('\n'));
    }
}
