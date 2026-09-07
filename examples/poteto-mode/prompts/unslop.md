Unslop this. Target (default: the current uncommitted diff, or the last reply if there is no diff):

$ARGUMENTS

For code
- Delete comments that say what the code does, mark phases, or assert correctness. Keep only comments that explain a non-obvious why.
- Delete defensive checks for states the types already forbid.
- Delete abstractions with one caller. Inline them.
- Delete configuration, options, and parameters nothing uses.
- Delete dead branches and unreachable fallbacks.
- Replace generic names with domain names.
- Do not change behavior. Run the existing tests before and after and quote both summary lines.

For prose
- One thought per sentence. Cut sentences over about twenty words in two.
- Remove long dashes, mid-sentence colons, and hedges.
- Remove restatements, summaries of what was just said, and closing offers.
- Lead with the outcome.
- Keep every fact. Cut only words.

Reply format
- The diff, or the rewritten text.
- A count of lines removed and lines added.
- For code, the test summary before and after.

Short declarative sentences. No long dashes.
