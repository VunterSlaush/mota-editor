# ADR-0014 — Subtasks: scoped tabs on the same folder

- Status: accepted
- Date: 2026-08-14

## Context

Worktree tabs (ADR-0007) give parallel agents isolation by giving each
one its own checkout. That is the right tool for parallel *writing*, but
it is heavy for two other jobs: an agent that should only *study* a
repository, and an agent that should work one corner of a monorepo — the
frontend package, a feature folder — without straying. Both want the
same folder the user already has open, just with less authority.

## Decision

- A **subtask** is an ordinary tab whose `Project` carries an optional
  `subtask` scope — the same optional-field trick as `worktreeOf`, so
  old workspace files load unchanged. There is no on-disk artifact: a
  subtask exists as a tab plus its workspace entry, nothing else.
- Two access levels:
  - **`read-only`** — the agent may read the folder and nothing more.
  - **`boundary`** — the agent may **read anywhere** inside the root but
    **write only inside** user-selected repository-relative folders.
    Reads stay open because monorepo work is exactly the case where the
    bounded corner imports shared code it must be able to see.
- Several subtask tabs and the plain tab **coexist on one folder**: the
  open-tab dedup by path applies only when neither side is a subtask.
- The scope is **editable after creation**. It is part of the backend's
  `SessionSpec`, so a change retires the live agent session and respawns
  it through the existing reconfigure-and-recover path — sandbox flags
  are spawn-time, so no running process is ever asked to narrow itself.
- Enforcement is **three-layered**, and the layers are not equal:
  1. **Mota-enforced (mechanical):** ACP client-fs writes go through a
     scope-aware extension of `confine_to_project`; the path decision is
     a pure, unit-tested function in `agent-core`. `terminal/create` is
     refused under `read-only` — a shell writes anywhere, so blocking it
     is what makes read-only a real guarantee.
  2. **Vendor spawn flags (mechanical where the vendor has one):**
     codex gets `--sandbox read-only`; every scoped tab suppresses the
     bypass flags (`--dangerously-skip-permissions`, `--yolo`,
     `--full-auto`). No vendor exposes a per-folder write allowlist, so
     `boundary` has no vendor flag of its own.
  3. **Prompt preamble (advisory):** `effective_prompt` states the scope
     to every provider, so even a vendor tool doing direct I/O is told.
- The permission policy is capped by the scope: `read-only` forces
  `manual`, `boundary` caps `bypass` down to `auto` — Mota's own
  auto-approval must never approve what the scope forbids.
- The scope preamble is written by **both** prompt paths: `effective_prompt`
  for the headless fallback and `acp::prompt_request_for_provider` for the
  ACP transport real turns actually take. It is deliberately NOT skipped
  for a provider with a native mode, unlike the mode preamble — no vendor
  enforces a folder boundary for us, so there is nothing to defer to.
- A project may name its **boundary areas** once — `BoundaryPreset`, a
  name plus folders — and the picker offers them as one click. They live
  on the `Project` (per project, shared by every tab on that folder)
  because the paths do: `apps/web` describes one repository. Unlike a
  scope they fail **open** at restore: a preset is a convenience, not a
  restriction, so an unusable one is dropped rather than narrowed.
- The Subtasks settings section can ask an agent to propose those areas.
  It runs through `acp_session::ask_once` — a throwaway, read-only
  session that never touches a tab's conversation or context window —
  and it runs only after a confirmation that states plainly that the
  request spends tokens from the user's plan. The answer is a draft: the
  parser drops any path that is absolute or escaping (model output is
  untrusted input), and nothing is saved until the user keeps it.

## Consequences

- **The guarantee is honest, not absolute.** Vendor CLIs own their tools
  and may touch the disk directly; only the ACP client-fs surface, the
  terminal surface, and codex's sandbox are mechanical. Under
  `boundary`, agent-spawned terminals still run unconfined (cwd stays
  the root) — accepted for v1 and stated in the UI copy's spirit: a
  boundary steers an agent, a worktree isolates one.
- MCP servers run as their own processes with their own credentials,
  outside the scope entirely.
- Transcripts are keyed by project-path hash, so a subtask shares its
  history directory with the plain tab on the same folder. Accepted for
  v1; sessions remain distinguishable by id.
- A malformed persisted scope restores as `read-only`, never as
  unrestricted — failing closed is the only acceptable failure here.
