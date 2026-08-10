# ADR-0009 — An interactive terminal in the right panel

- Status: accepted
- Date: 2026-08-10
- Relates to: ADR-0005 (ACP sessions), ADR-0008 (spawn only through argv)

## Context

The app drives agent CLIs but gives the user nowhere to type a command.
Running `npm test`, reading `git log`, or starting a dev server means
leaving the window, and leaving the window means leaving the worktree
the tab is pointing at — which is exactly the context ADR-0007 exists to
keep straight.

`src-tauri/src/terminal.rs` looks like the answer and is not. It is the
client side of ACP `terminal/*`: the **agent** names a command, we run
it through pipes under a byte cap, and the transcript polls the captured
output. Its own module doc records the limit — *"No PTY: output is pipe
capture, so fully interactive programs degrade."* It has no input path,
no size, and no push streaming, and its lifetime is an agent session's.
None of that is fixable without changing what it is for.

## Decision

### A real pty, in a second capability alongside the first

`src-tauri/src/shell_session.rs` owns one pty per terminal via
`portable-pty` (ConPTY on Windows, `openpty` elsewhere), rendered by
xterm.js in `src/ui/terminals/`. Colours, prompts, `Ctrl+C`, resize,
REPLs and full-screen programs all work, because the child is talking to
a tty rather than to us.

### Two concepts, two words

`terminal` stays the **agent's** word: ACP `terminal/*`, `terminal.rs`,
`AgentGateway.readTerminalOutput`. `shell` is the **user's**: `ShellPort`,
`ShellSession`, `shell_open`. The UI still says "Terminal", because that
is what a person calls it, but no identifier is shared and no ACP method
reaches a user's pty. The agent cannot type into the user's shell, and
the separation is structural rather than a rule someone has to remember.

### Why this does not break the argv-only rule

ADR-0008 requires that `runner::os_command` "spawns a resolved binary
with an argv vector and **never a shell**". A terminal is a shell, so
the rule deserves a straight answer rather than an exception.

The rule exists because the app used to be tempted to build command
*strings* out of repo-controlled input — branch names, file paths,
prompts — where a `&` or a `|` becomes someone else's command. That
temptation is absent here:

- The shell binary is resolved by the existing `runner::resolve_program`
  (PATH only, never the project folder) and spawned with an argv vector.
- The app never composes a command line. What follows the prompt is
  bytes a human typed, which the shell parses because that is what the
  user asked it to do.
- The Settings override is a **program path**, not a command. It is
  resolved the same way and spawned the same way; nothing interpolates
  it. A path we cannot resolve is an error the user sees, never a
  silent fallback to a different shell (`agent_core::shell` returns the
  configured shell as the *only* candidate, deliberately).

So the invariant that matters — *no string the app assembled is ever
handed to a command interpreter* — holds unchanged.

### The shell policy is pure; the pty is not

`agent-core` is machine-locked to serde-only, so `portable-pty` cannot
live there. What can, and does: `agent_core::shell` — the candidate
table per platform, the override rule, and the pty-size clamp. Platform
and environment are arguments rather than `cfg!` reads, so every branch
is testable from one machine.

### Lifecycle: a terminal never outlives what owns it

- Closing a terminal kills its process **tree**, not just the shell.
  Windows needs `taskkill /T`; elsewhere the pty session leader heads a
  process group, so a negative pid reaches it.
- Closing a project tab closes its terminals, before anything else.
  This is what makes worktree removal work: `RemoveWorktree` closes the
  tab first, and on Windows a live shell holds a handle on its working
  directory that would make the delete fail outright.
- App exit kills all of them, next to the existing ACP shutdown.

### Output does not go through the store

`ShellStream.onOutput` runs from the adapter straight into the xterm
instance. Only lifecycle transitions — opened, exited, closed, selected
— reach the reducer. A build log through `reduce` would re-render the
workbench on every frame of output, which is the opposite of the point.

For the same reason the xterm instances live in a module-level registry
in `src/ui/terminals/shellRegistry.ts` rather than in component state:
`ChatPanel` is keyed by project id and remounts on every project switch,
and a remount must not throw away the scrollback of a build that is
still running.

### Streaming shape

One `shell-event` topic with a `sessionId` discriminator, matching
`runner::EVENT_CHANNEL`; the adapter keeps one listener and fans out.
Bytes travel base64-encoded because chunk boundaries land mid-character
constantly and a lossy decode per chunk would corrupt output.

Output is batched, with one rule that keeps typing responsive: a read
that came back short drained the pty, so it flushes at once; only a read
that filled the buffer is coalesced (to 64 KB or 16 ms). An echoed
keystroke is never delayed; a build log becomes dozens of messages
instead of thousands.

## Consequences

- Two new dependencies: `portable-pty` (Rust) and `@xterm/xterm` +
  `@xterm/addon-fit` (~70 KB gzipped). For a product whose pitch is
  being lightweight, this is the largest single addition so far, and it
  buys the one thing a pipe cannot: a tty.
- `@xterm/addon-webgl` is deliberately **not** taken. The default
  renderer is adequate; if a dev server's output ever stutters, that is
  the next 40 KB to spend and not before.
- The right-hand column now holds one of two panels — plan or terminal —
  rather than the plan's own boolean. Two resizable columns beside a
  chat leave the chat with nothing.
- Terminals are not restored across restarts. A pty cannot outlive the
  process that owned it, and pretending otherwise would mean restoring a
  dead scrollback.
- `terminal` in this codebase now always means the agent's, and `shell`
  always means the user's. Blurring them later re-opens exactly the
  question this ADR closed.
