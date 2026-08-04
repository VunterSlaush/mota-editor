# Coding Standards

Derived from Robert C. Martin's *Clean Code* and the conventions visible in
his public repositories (fitnesse, more-speech, CC_SMC, and the Clean
Coders case study). These are working rules, not aspirations: pull requests
are reviewed against them.

## The prime directive

> "Make sure you write tests for the code you write, and follow the
> conventions I've started here." — more-speech README

## Functions

- Small, then smaller. A function does one thing iff you cannot extract
  another function from it: "Extract till you just can't extract any more.
  Extract till you drop."
- One level of abstraction per function; files read top-down like a
  narrative (Stepdown Rule). See `sendPrompt.ts` or `claude.rs` — the
  public entry first, the helpers it tells the story with below.
- Few arguments: 0–2 preferred, 3 needs a justification, more means the
  arguments want to become an object (see `AgentTurnRequest`,
  `StartTurnArgs`).
- No boolean flag arguments; split the function instead.
- Command–query separation: a function either answers a question or
  changes state — never both, and never a side effect its name hides.
- Errors are values or exceptions at the boundary, never silent: adapters
  translate low-level failures into messages a user can act on
  (`spawn_error` → "The `claude` CLI was not found on your PATH.").

## Names

- Intention-revealing. If a name needs a comment, the name failed. Emulate
  the case study's `findAllCodecastsSortedChronologically()`: the name
  carries the full contract.
- Pronounceable and searchable; no abbreviations, no Hungarian, no noise
  words (`data`, `info`, `manager`).
- Classes and types are nouns (`SendPrompt` is a use case — its noun is the
  use case itself); methods are verbs; one word per concept across the
  codebase (`turn` is always one prompt→completion cycle; `session` is
  always the provider-side conversation; `tab` is always the UI identity of
  a project).

## Tests

- **Test-first is the default.** The Three Laws of TDD:
  1. No production code except to make a failing test pass.
  2. No more of a test than is sufficient to fail.
  3. No more production code than is sufficient to pass.
- Tests follow **FIRST**: Fast, Independent, Repeatable, Self-Validating,
  Timely. The whole unit suite must stay in the seconds range — anything
  slower belongs in a separate suite (fitnesse splits `test` from
  `acceptanceTest`; we split `vitest`/`cargo test` from future E2E).
- Test through the ports with fakes, not mocks of frameworks:
  `FakeAgentGateway` in `sendPrompt.test.ts` is the pattern — scripted,
  in-memory, assertable.
- Test files live next to what they test (`appState.test.ts`) or in a
  `#[cfg(test)]` module in the same file (Rust), mirroring the source
  structure like more-speech's `spec/` tree mirrors `src/`.
- One concept per test; the test name states the behavior, not the method
  (`re-activates the existing tab when the same folder is opened twice`).

## Boundaries (the architectural rules, enforced in review)

- `src/core/**` imports nothing from `react`, `@tauri-apps/*`, or
  `src/adapters/**`. Ever.
- `src-tauri/agent-core` depends on `serde`/`serde_json` only — no tokio,
  no tauri, no I/O.
- Only DTOs cross a boundary; wire shapes are converted at the adapter
  (`toDomainEvent`), never passed through.
- New vendor = new adapter file implementing the existing port/trait. If
  adding a provider forces an edit to a use case, the design has been
  broken — stop and fix the boundary instead.
- All wiring of concrete classes happens in `src/wiring/context.ts` and
  `src-tauri/src/lib.rs`. Nothing else calls a constructor of an adapter.

## Comments & formatting

- Comments explain **why**, never **what**; a comment that paraphrases the
  code is a failure to express intent in code — extract and name instead.
- Doc comments on every public boundary (ports, traits, use cases) state
  the role the item plays in the architecture, as done throughout.
- Formatting is mechanical, never debated: `rustfmt` and the default
  TypeScript/Prettier-style layout; `cargo clippy --workspace` stays at
  zero warnings; `tsc --noEmit` stays clean with `strict: true`.

## The Boy Scout Rule

> "Leave the campground cleaner than you found it."

Every change may include small opportunistic cleanups (a better name, an
extracted function, a dead line removed) in the files it already touches.
Large refactors get their own commit with tests green before and after.
