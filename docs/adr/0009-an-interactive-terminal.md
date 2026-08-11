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

### Suggestions are ours, not the shell's

The greyed-out completion is drawn by us, from a history we rank
ourselves. The obvious alternative was to let the shell do it —
PSReadLine's predictive IntelliSense, `zsh-autosuggestions` — and it was
rejected on measurement:

- The machine this was built on runs Windows PowerShell 5.1 with
  PSReadLine **2.0.0**. `Set-PSReadLineOption -PredictionSource` does
  not exist before 2.1.0, so the feature was simply unavailable.
- Getting it means installing something — `pwsh` 7 (~250 MB) or a newer
  PSReadLine (~2 MB) — plus a startup snippet injected into the user's
  shell profile to make it stick.
- It would work in PowerShell and nowhere else. `cmd` and Git Bash, both
  of which this terminal happily runs, would have nothing.
- Its ranking is recency-with-prefix. Measured against a real history,
  `cls` and `clear` are 43% of all entries, so recency and frequency
  disagree constantly.

Doing it ourselves needs no install, no profile injection, and works
identically in every shell.

**We know what is typed because we typed it.** Every byte the panel
sends passes through `entities/inputLine` first, so no OSC 133 shell
integration is needed. That model is a guess about the shell's line
editor, and it fails closed: any control byte we do not model — Tab, an
arrow, Ctrl+R — sets the line to null and suggestions stop until the
next prompt. A missing suggestion is a shrug. A suggestion computed from
a line we had wrong would insert text the user never typed, and that is
the failure the shape of `InputLine` exists to make impossible.

**Accepting types the rest in.** Right arrow and Tab send the remaining
characters as keystrokes rather than reaching into the shell's buffer,
so both line editors end up believing the same thing. Both are only
intercepted while a suggestion is showing — which is only when the
cursor is at the end of a line we followed exactly, and where Right
arrow would have done nothing anyway. Tab is the key a person actually
reaches for with a completion greyed in under the cursor; left to the
shell it ran its own completion and inserted something else entirely.
With no suggestion showing it still goes straight through, so the
shell's own completion is untouched.

**The corpus is the shell's own history file, read and never written.**
The shell keeps it current, including commands run in our terminal, so a
copy of ours would only be a second thing to get out of step.

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
- Suggestions cost, measured against a 14,215-entry history: **44 KB** of
  heap for the ranked index (842 distinct commands), **4.4 ms** to build
  it once at startup, **3 µs** per keystroke to look one up, and
  **+3.6 KB / +1.2 KB gzipped** of bundle. No disk of our own.
- We read the user's shell history file. It never leaves the machine and
  nothing is written back, but it is personal data, and the Settings
  toggle that turns suggestions off should stay the thing that stops us
  reading it.
- The line model will desync on anything exotic — a shell that rewrites
  the prompt, a full-screen program, bracketed-paste edge cases. The
  cost of each is one missing suggestion, and the model recovers at the
  next prompt.
