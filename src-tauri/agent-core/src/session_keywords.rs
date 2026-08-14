//! What a conversation was ABOUT, in a handful of words.
//!
//! History rows carry a title — the first 80 characters of the opening
//! prompt — and nothing else, so searching history means searching the
//! way a conversation started rather than what it turned out to be
//! about. These keywords are the rest of the answer: the terms a session
//! actually dwells on, small enough to hold every session's set in
//! memory at once and match a query against them instantly.
//!
//! Frequency, not cleverness. A term that keeps coming back in a
//! conversation is what that conversation was about; a term used once is
//! not a theme. Nothing here is trained, fetched, or configured, which
//! is what keeps a search cheap enough to run on a keystroke.
//!
//! Pure text work, per the Dependency Rule: finding and reading the
//! transcripts is the shell's job (`history_file.rs` in the outer crate).

use std::collections::HashMap;

/// How many keywords one session keeps. Enough to describe what a long
/// conversation covered, small enough that a hundred sessions' worth is
/// a few kilobytes.
pub const MAX_KEYWORDS: usize = 40;

/// Shortest term worth keeping. Two-letter tokens are almost all noise
/// (`if`, `ok`, `fn`), and the ones that are not (`id`, `ui`) are too
/// common to tell two sessions apart.
const MIN_TERM_CHARS: usize = 3;

/// Longest term worth keeping. Anything past this is a hash, a base64
/// blob, or a minified line — never a theme.
const MAX_TERM_CHARS: usize = 32;

/// How much of one conversation is read. A session that ran for hours
/// is already described by its first few hundred thousand characters,
/// and the cap is what stops one runaway transcript from deciding how
/// long the whole index takes to build.
pub const MAX_CHARS_SCANNED: usize = 200_000;

/// The terms `texts` keeps coming back to, most frequent first, at most
/// `MAX_KEYWORDS` of them.
///
/// Ties break alphabetically so that indexing the same conversation
/// twice yields the same list — a set that reshuffled between runs would
/// make search results move around for no reason the user can see.
pub fn keywords<'a>(texts: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut scanned = 0usize;
    for text in texts {
        if scanned >= MAX_CHARS_SCANNED {
            break;
        }
        let room = MAX_CHARS_SCANNED - scanned;
        let slice = truncate_chars(text, room);
        scanned += slice.chars().count();
        for term in terms(slice) {
            *counts.entry(term).or_insert(0) += 1;
        }
    }

    let mut ranked: Vec<(String, usize)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked.truncate(MAX_KEYWORDS);
    ranked.into_iter().map(|(term, _)| term).collect()
}

/// The countable terms in one string: lowercased, split on anything that
/// is not a letter or digit, minus the words every conversation uses.
fn terms(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| keepable(word))
        .map(str::to_lowercase)
        .filter(|term| !is_stop_word(term))
}

/// Whether a raw token could be a theme at all, before it is lowercased.
/// Pure digits go: a line number or a byte count describes nothing.
fn keepable(word: &str) -> bool {
    let length = word.chars().count();
    (MIN_TERM_CHARS..=MAX_TERM_CHARS).contains(&length)
        && word.chars().any(|c| c.is_alphabetic())
        && !is_short_hash(word)
}

/// A commit hash and its relatives: seven or more characters, every one
/// of them hex. The length floor matters — `beef`, `decade` and `facade`
/// are also all-hex, and they are words someone might search for.
fn is_short_hash(word: &str) -> bool {
    word.chars().count() >= 7 && word.chars().all(|c| c.is_ascii_hexdigit())
}

/// `text` cut to at most `limit` CHARACTERS, never splitting one. Byte
/// slicing would panic on the first multi-byte character in a language
/// this app has no opinion about.
fn truncate_chars(text: &str, limit: usize) -> &str {
    match text.char_indices().nth(limit) {
        Some((at, _)) => &text[..at],
        None => text,
    }
}

/// Words too common to distinguish one session from another: ordinary
/// English glue, plus the vocabulary every conversation with a coding
/// agent contains ("file", "code", "error"). Leaving those in would make
/// every session share its top terms, which is the same as having none.
fn is_stop_word(term: &str) -> bool {
    STOP_WORDS.binary_search(&term).is_ok()
}

/// Sorted, so the lookup can binary-search it. Keep it that way.
const STOP_WORDS: &[&str] = &[
    "about", "add", "added", "after", "again", "all", "also", "and", "another", "any",
    "are", "back", "because", "been", "before", "being", "both", "but", "call", "called",
    "can", "cannot", "change", "changes", "check", "code", "could", "did", "does",
    "doing", "done", "down", "each", "else", "error", "errors", "even", "every",
    "example", "file", "files", "first", "fix", "fixed", "for", "found", "from", "get",
    "give", "going", "good", "got", "had", "has", "have", "help", "her", "here", "him",
    "his", "how", "into", "issue", "its", "just", "keep", "know", "last", "let", "like",
    "line", "lines", "look", "looks", "made", "make", "many", "may", "might", "more",
    "most", "much", "must", "need", "needs", "new", "next", "not", "now", "off", "one",
    "only", "open", "other", "our", "out", "over", "own", "part", "please", "put",
    "really", "right", "run", "running", "said", "same", "see", "set", "she", "should",
    "show", "since", "some", "still", "such", "sure", "take", "than", "that", "the",
    "their", "them", "then", "there", "these", "they", "thing", "things", "think",
    "this", "those", "through", "time", "too", "took", "try", "trying", "two", "under",
    "update", "updated", "use", "used", "using", "very", "want", "was", "way", "well",
    "were", "what", "when", "where", "which", "while", "who", "why", "will", "with",
    "work", "working", "would", "you", "your",
];

#[cfg(test)]
mod tests {
    use super::*;

    fn of(texts: &[&str]) -> Vec<String> {
        keywords(texts.iter().copied())
    }

    #[test]
    fn stop_words_are_sorted_so_the_lookup_works() {
        let mut sorted = STOP_WORDS.to_vec();
        sorted.sort_unstable();
        assert_eq!(STOP_WORDS, sorted.as_slice());
    }

    #[test]
    fn ranks_the_terms_a_conversation_keeps_coming_back_to() {
        let found = of(&[
            "the parser drops a token",
            "the parser needs a test",
            "parser again, and a scanner",
        ]);
        assert_eq!(found.first().map(String::as_str), Some("parser"));
        assert!(found.contains(&"scanner".to_owned()));
    }

    #[test]
    fn leaves_out_the_words_every_conversation_uses() {
        let found = of(&["please fix the file with the error in this code"]);
        assert!(found.is_empty(), "expected no themes, got {found:?}");
    }

    #[test]
    fn leaves_out_tokens_too_short_or_too_long_to_be_a_theme() {
        let hash = "a".repeat(MAX_TERM_CHARS + 1);
        let found = of(&[&format!("ui fn {hash} worktree")]);
        assert_eq!(found, vec!["worktree".to_owned()]);
    }

    #[test]
    fn leaves_out_bare_numbers_and_hex_blobs() {
        let found = of(&["line 4213 at deadbeef in the reducer"]);
        assert_eq!(found, vec!["reducer".to_owned()]);
    }

    #[test]
    fn lowercases_so_a_search_never_has_to_guess_the_case() {
        assert_eq!(of(&["Reducer REDUCER reducer"]), vec!["reducer".to_owned()]);
    }

    #[test]
    fn breaks_ties_alphabetically_so_two_runs_agree() {
        let once = of(&["alpha beta gamma"]);
        let twice = of(&["gamma beta alpha"]);
        assert_eq!(once, twice);
        assert_eq!(once, vec!["alpha", "beta", "gamma"]);
    }

    #[test]
    fn keeps_at_most_the_documented_number_of_keywords() {
        let many: Vec<String> = (0..MAX_KEYWORDS * 3).map(|n| format!("term{n:04}")).collect();
        let joined = many.join(" ");
        assert_eq!(of(&[&joined]).len(), MAX_KEYWORDS);
    }

    #[test]
    fn stops_reading_once_a_conversation_has_said_enough() {
        let huge = "chatter ".repeat(MAX_CHARS_SCANNED);
        // The cap is reached inside the first text, so the second one —
        // where the only other term lives — is never read.
        let found = of(&[&huge, "worktree"]);
        assert_eq!(found, vec!["chatter".to_owned()]);
    }

    #[test]
    fn splits_on_punctuation_the_way_prose_and_paths_both_need() {
        let found = of(&["src/core/worktrees.ts:42 — worktrees, worktrees!"]);
        assert_eq!(found.first().map(String::as_str), Some("worktrees"));
        assert!(found.contains(&"src".to_owned()));
    }

    #[test]
    fn survives_text_that_is_not_ascii() {
        let found = of(&["привет мир мир мир", "café café"]);
        assert_eq!(found.first().map(String::as_str), Some("мир"));
        assert!(found.contains(&"café".to_owned()));
    }
}
