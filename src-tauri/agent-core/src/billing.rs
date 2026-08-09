//! Billed token usage, parsed from a vendor CLI's own session log.
//!
//! Distinct from the ACP `usage_update` in [`crate::event`]: that reports
//! context-window OCCUPANCY (`used` of `size`), which is not what anyone
//! is charged for. These are the tokens the vendor actually billed —
//! input, output, and the cache reads and writes that dominate a long
//! session's cost and are invisible over ACP.
//!
//! Pure parsing only, per the Dependency Rule: finding and reading the
//! files is the shell's job (`billing_log.rs` in the outer crate).

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Model id the vendor stamps on messages IT generated locally
/// (interrupts, errors, tool stubs). No API call was made, so nothing was
/// billed — pricing these would invent spend that never happened.
const SYNTHETIC_MODEL: &str = "<synthetic>";

/// Billed usage for one API request.
///
/// Cache writes are split by TTL because they are priced differently
/// (1h costs more than 5m); the shell keeps them apart so the pricing
/// table, not the parser, decides what a token costs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BilledRequest {
    pub request_id: String,
    /// The PROVIDER's session id — matches a transcript's
    /// `providerSessionId`, not our local session id.
    pub session_id: String,
    pub timestamp_ms: i64,
    pub model: String,
    /// True for subagent traffic, which the vendor bills to the same
    /// account but which no top-level turn accounts for.
    pub is_sidechain: bool,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_write_5m_tokens: u64,
    pub cache_write_1h_tokens: u64,
    pub cache_read_tokens: u64,
}

/// Parse one line of a vendor session log, or `None` when it carries no
/// billed usage — blank, malformed, not an assistant message, vendor-
/// generated, or missing the usage block. Never panics: these files are
/// written by another program and may gain fields or be half-flushed.
pub fn parse_billed_line(line: &str) -> Option<BilledRequest> {
    let raw: RawLine = serde_json::from_str(line.trim()).ok()?;
    if raw.line_type != "assistant" || raw.request_id.is_empty() {
        return None;
    }
    let message = raw.message?;
    if message.model == SYNTHETIC_MODEL {
        return None;
    }
    let usage = message.usage?;
    let (write_5m, write_1h) = match usage.cache_creation {
        Some(split) => (
            split.ephemeral_5m_input_tokens,
            split.ephemeral_1h_input_tokens,
        ),
        // Older lines report only the total, with no TTL breakdown.
        // Charge it at the 5m rate — the cheaper of the two, so an
        // unknown TTL can never inflate the reported spend.
        None => (usage.cache_creation_input_tokens, 0),
    };
    Some(BilledRequest {
        request_id: raw.request_id,
        session_id: raw.session_id,
        timestamp_ms: parse_iso8601_ms(&raw.timestamp).unwrap_or(0),
        model: message.model,
        is_sidechain: raw.is_sidechain,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_write_5m_tokens: write_5m,
        cache_write_1h_tokens: write_1h,
        cache_read_tokens: usage.cache_read_input_tokens,
    })
}

/// Keep the first entry per request id and drop the rest.
///
/// MANDATORY, not an optimization. The vendor writes one line per content
/// block of a reply (text, thinking, each tool call) and stamps the
/// WHOLE REQUEST's usage on every one of them. Summing the lines
/// overcounts by the average block count — measured at 3.25x on a real
/// 87-line session. Taking the first is safe because the repeats are
/// byte-identical, not partial.
pub fn dedupe_by_request_id(requests: Vec<BilledRequest>) -> Vec<BilledRequest> {
    let mut seen: HashSet<String> = HashSet::new();
    requests
        .into_iter()
        .filter(|request| seen.insert(request.request_id.clone()))
        .collect()
}

/// Epoch milliseconds from an ISO-8601 UTC stamp
/// (`2026-08-09T13:09:43.642Z`), or `None` if it isn't one.
///
/// Hand-rolled to keep this crate dependency-free: the vendor writes one
/// fixed format, so a date-time library would be a lot of surface area
/// for a fixed-width slice.
fn parse_iso8601_ms(stamp: &str) -> Option<i64> {
    let bytes = stamp.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let field = |from: usize, to: usize| stamp.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (field(0, 4)?, field(5, 7)?, field(8, 10)?);
    let (hour, minute, second) = (field(11, 13)?, field(14, 16)?, field(17, 19)?);
    // Fractional seconds are optional and of unspecified length.
    let millis = match stamp.get(19..20) {
        Some(".") => {
            let digits: String = stamp[20..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            format!("{digits:0<3}").get(..3)?.parse::<i64>().ok()?
        }
        _ => 0,
    };
    let days = days_from_civil(year, month, day);
    Some(((days * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000) + millis)
}

/// Days between 1970-01-01 and the given civil date (Howard Hinnant's
/// `days_from_civil`, the standard proleptic-Gregorian conversion).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let shifted_month = (month + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The subset of a log line this module reads. Every field is optional:
/// the file is another program's format and lines vary by vintage.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawLine {
    #[serde(rename = "type", default)]
    line_type: String,
    #[serde(default)]
    request_id: String,
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    is_sidechain: bool,
    #[serde(default)]
    timestamp: String,
    #[serde(default)]
    message: Option<RawMessage>,
}

#[derive(Deserialize)]
struct RawMessage {
    #[serde(default)]
    model: String,
    #[serde(default)]
    usage: Option<RawUsage>,
}

/// Note what is NOT read here: `usage.iterations[]` repeats these same
/// counters per internal step, so deserializing and adding it would
/// double-count the request against itself.
#[derive(Deserialize)]
struct RawUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_creation: Option<RawCacheCreation>,
}

#[derive(Deserialize)]
struct RawCacheCreation {
    #[serde(default)]
    ephemeral_5m_input_tokens: u64,
    #[serde(default)]
    ephemeral_1h_input_tokens: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Shape copied from a real log line, trimmed of fields we ignore.
    const NORMAL: &str = r#"{"parentUuid":"p","isSidechain":false,"message":{"model":"claude-opus-5","role":"assistant","content":[],"usage":{"input_tokens":2,"cache_creation_input_tokens":9569,"cache_read_input_tokens":22051,"output_tokens":114,"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":9569,"ephemeral_5m_input_tokens":0},"iterations":[{"input_tokens":2,"output_tokens":114,"cache_read_input_tokens":22051,"cache_creation_input_tokens":9569}]}},"requestId":"req_a","type":"assistant","timestamp":"2026-08-09T13:09:43.642Z","cwd":"G:\\mota-editor-wks-1","sessionId":"sess-1"}"#;

    fn parsed(line: &str) -> BilledRequest {
        parse_billed_line(line).expect("line should carry billed usage")
    }

    #[test]
    fn reads_every_billed_field_from_a_normal_line() {
        let request = parsed(NORMAL);
        assert_eq!(request.request_id, "req_a");
        assert_eq!(request.session_id, "sess-1");
        assert_eq!(request.model, "claude-opus-5");
        assert!(!request.is_sidechain);
        assert_eq!(request.input_tokens, 2);
        assert_eq!(request.output_tokens, 114);
        assert_eq!(request.cache_write_1h_tokens, 9569);
        assert_eq!(request.cache_write_5m_tokens, 0);
        assert_eq!(request.cache_read_tokens, 22051);
    }

    #[test]
    fn ignores_the_iterations_breakdown_that_would_double_count() {
        // NORMAL's `iterations` repeats all four counters. Reading them
        // would report 228 output tokens for a 114-token reply.
        assert_eq!(parsed(NORMAL).output_tokens, 114);
    }

    #[test]
    fn keeps_one_entry_per_request_id() {
        // The 3.25x trap: the vendor stamps whole-request usage on every
        // content block, so three lines here are ONE billed request.
        let lines = [
            NORMAL,
            &NORMAL.replace("\"content\":[]", "\"content\":[{}]"),
            NORMAL,
        ];
        let all: Vec<_> = lines.iter().filter_map(|l| parse_billed_line(l)).collect();
        assert_eq!(all.len(), 3, "all three lines parse");

        let deduped = dedupe_by_request_id(all);
        assert_eq!(deduped.len(), 1);
        assert_eq!(deduped.iter().map(|r| r.output_tokens).sum::<u64>(), 114);
    }

    #[test]
    fn keeps_distinct_requests_apart() {
        let other = NORMAL.replace("req_a", "req_b");
        let all = vec![parsed(NORMAL), parsed(&other), parsed(NORMAL)];
        assert_eq!(dedupe_by_request_id(all).len(), 2);
    }

    #[test]
    fn marks_subagent_traffic() {
        let line = NORMAL.replace("\"isSidechain\":false", "\"isSidechain\":true");
        assert!(parsed(&line).is_sidechain);
    }

    #[test]
    fn charges_an_unsplit_cache_write_at_the_cheaper_ttl() {
        let line = NORMAL.replace(
            r#","cache_creation":{"ephemeral_1h_input_tokens":9569,"ephemeral_5m_input_tokens":0}"#,
            "",
        );
        let request = parsed(&line);
        assert_eq!(request.cache_write_5m_tokens, 9569);
        assert_eq!(request.cache_write_1h_tokens, 0);
    }

    #[test]
    fn skips_lines_that_bill_nothing() {
        let cases = [
            ("blank", ""),
            ("malformed", "{not json"),
            ("truncated", r#"{"type":"assistant","requestId":"r","mess"#),
            (
                "not an assistant message",
                &NORMAL.replace(r#""type":"assistant""#, r#""type":"user""#),
            ),
            (
                "no usage block",
                r#"{"type":"assistant","requestId":"r","message":{"model":"claude-opus-5"}}"#,
            ),
            (
                "no message at all",
                r#"{"type":"assistant","requestId":"r"}"#,
            ),
            (
                "no request id",
                &NORMAL.replace(r#""requestId":"req_a","#, ""),
            ),
            (
                "vendor-generated",
                &NORMAL.replace("claude-opus-5", "<synthetic>"),
            ),
        ];
        for (what, line) in cases {
            assert!(parse_billed_line(line).is_none(), "{what} should not bill");
        }
    }

    #[test]
    fn reads_the_timestamp_as_epoch_millis() {
        // 2026-08-09T13:09:43.642Z
        assert_eq!(parsed(NORMAL).timestamp_ms, 1_786_280_983_642);
    }

    #[test]
    fn survives_a_timestamp_it_cannot_read() {
        // Better a request at epoch 0 than a billed request dropped: the
        // totals stay right even when the date bucket does not.
        let line = NORMAL.replace("2026-08-09T13:09:43.642Z", "yesterday");
        let request = parsed(&line);
        assert_eq!(request.timestamp_ms, 0);
        assert_eq!(request.output_tokens, 114);
    }

    #[test]
    fn reads_timestamps_without_fractional_seconds() {
        let line = NORMAL.replace("2026-08-09T13:09:43.642Z", "2026-08-09T13:09:43Z");
        assert_eq!(parsed(&line).timestamp_ms, 1_786_280_983_000);
    }

    #[test]
    fn converts_dates_across_leap_years_and_epochs() {
        let at = |stamp: &str| parse_iso8601_ms(stamp).expect("valid stamp");
        assert_eq!(at("1970-01-01T00:00:00.000Z"), 0);
        assert_eq!(at("2000-02-29T00:00:00.000Z"), 951_782_400_000);
        assert_eq!(at("2024-12-31T23:59:59.999Z"), 1_735_689_599_999);
    }
}
