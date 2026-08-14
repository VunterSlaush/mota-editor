# ADR-0012 — Searching history by what a session was about

- Status: accepted
- Date: 2026-08-13

## Context

A history row's only searchable text was its `title`: the first 80
characters of the opening prompt. Searching history therefore meant
searching how a conversation *started*, not what it turned out to be
about — and after ADR-0007's worktrees, the main checkout's panel lists
every checkout's sessions, so the list to search through got longer at
the same time as it stayed shallow.

Reading the conversations themselves is not obviously expensive, because
that cost is already being paid: `list_sessions` reads and fully parses
every transcript on every panel open, keeps six header fields, and
discards the rest. The question was never "can we afford to read the
text" but "what do we keep from it, and where".

## Decision

- Each session gets **up to 40 keywords**, ranked by frequency
  (`agent_core::session_keywords`). Frequency, not relevance scoring, not
  embeddings: a term a conversation keeps returning to is what it was
  about, and nothing here is trained, fetched, or configured. Stop words
  cover ordinary English plus the vocabulary every agent chat contains
  (`file`, `error`, `code`), which would otherwise be every session's top
  terms and so distinguish none of them.
- The index is **built on demand — on the first keystroke in the search
  box — and held for the life of the panel**, not maintained on save. A
  panel that is opened and read pays nothing; the save path keeps no
  second record to fall out of date with the first, and there is no
  migration or rebuild path to get wrong. The price is one walk per
  search session, which is the walk the listing already does.
- **Titles still match first, and keyword matches are additive.** The
  index arrives asynchronously, so a search must return something before
  it lands. A row that matched on a keyword shows that word, because a
  result whose visible text does not contain the query reads as a bug.
- Search reaches **this repository** — the tab's checkout plus its
  worktrees — the same set the History panel lists. Searching folders
  that are not on screen would need results to name their project and
  opening one to switch tabs; a different feature.

## Consequences

- **Words from a conversation now cross the IPC boundary.**
  `session_index.rs` had held a deliberate line: of the full text in a
  session log, only the ≤80-character title snippet was allowed across,
  "which is the entire point of a history row". Keywords widen that line
  on purpose, and this is the record of it. What crosses is still bounded
  and derived: at most 40 single words per session, never a phrase,
  never a sentence, never the conversation. The transcripts they come
  from are the user's own, on the user's own disk, and no keyword leaves
  the machine.
- Exact-phrase search inside a conversation remains impossible: a phrase
  is not a keyword. If it is ever wanted, it needs a different index —
  and this one can be replaced without touching the panel, because the
  UI only ever sees `keywords(projectPath)`.
- Extraction is pure and in `agent-core`, so what counts as a theme is
  unit-tested without a filesystem. The stop-word list is data in that
  module; changing it changes tomorrow's search but not any stored file,
  since nothing is stored.
- A session whose conversation is all stop words indexes to nothing and
  stays findable by title alone. That is the correct answer, not a gap.
