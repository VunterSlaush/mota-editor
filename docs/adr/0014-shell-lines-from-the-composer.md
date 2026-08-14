# ADR-0014 — "!" runs a line in the user's own terminal

- Status: accepted
- Date: 2026-08-14
- Relates to: ADR-0009 (an interactive terminal), ADR-0008 (spawn only
  through argv)

## Context

The composer is where the hands already are. Everything else about a
project is one keystroke from it — `/` for commands, `@` for files — but
running `git status` means reaching for the terminal panel, finding the
right one, and typing there.

Asking the agent instead is the expensive habit this closes. A turn, a
permission prompt and a model's reading of the output, to learn something
the shell would have said in 30 ms and said exactly.

Claude Code answers this with `!`: the line runs locally and its output
is folded into the conversation, so the model sees it too.

## Decision

### The line goes to the pty, as keystrokes

A draft whose **first** character is `!` is not a prompt. The rest of it
is written to one of this project's terminals through the existing
`ShellPort`, followed by CR, and the terminal panel comes forward to show
the output.

Keystrokes rather than a new "run this and capture it" path, and the
reasons are all things already built:

- The shell echoes the command, so the terminal reads as though it had
  been typed there — because as far as the pty is concerned, it was.
- It passes through `entities/inputLine` like every other byte, so the
  history that feeds suggestions learns it and the running indicator
  (ADR-0009) stays honest.
- It is the user's own login shell, with their aliases, `PATH` and
  environment. A captured one-shot would have neither.
- No new port, no new capability, no new spawn path — so ADR-0008's
  argv-only rule is untouched. Nothing about it is a new decision.

The `!` has to be the first character, with nothing before it. That is
the escape hatch as much as the rule: a prompt that genuinely opens with
`!` still reaches the agent if it starts with a space.

### A busy terminal is not a terminal to type into

Keystrokes reach the foreground program's stdin, not a prompt. A tab
whose only terminal is running `npm run dev` would feed `git status` to
the dev server, which is worse than doing nothing.

So `entities/shellSession.idleShell` picks the terminal the user is
looking at when its prompt is free, else the first free one, and answers
*nothing* when every terminal is busy or dead. With nothing free the line
is **parked** on the tab (`pendingShellLine`) and the panel opens a
terminal for it; the line runs as that shell comes up, typed ahead of its
first prompt the way anyone who types faster than their shell does.

Parking, rather than a queue: a second `!` line replaces the first. Two
commands waiting on a shell nobody has opened yet is a queue whose order
the user cannot see, and the fix for a mistyped one has to be retyping
it, not remembering what is pending.

### The output does not reach the agent

This is where we stop short of Claude Code, deliberately.

The conversation lives on the CLI's side of the boundary; only a prompt
adds to it. Parity therefore means one of two things, and both cost more
than they return:

- **Spend a turn on it.** The command's output becomes a prompt, so the
  cheap thing we just made cheap is expensive again.
- **Prepend captured output to the next prompt.** That needs a capture
  runner as well as the pty — a second way to run commands, spawning
  `sh -lc <whatever was typed>`. ADR-0009 could answer the argv-only rule
  with "no string the app assembled ever reaches an interpreter"; a
  capture path handing a composed `-c` argument to a shell has a longer
  chain to defend, for a feature nobody has asked for yet.

Until someone wants the agent to read the output, `!` is for the human
reading it. When they do, an agent that can already run commands itself
is the shorter path — not a local runner bolted beside the pty.

## Consequences

- One field of new tab state (`pendingShellLine`) and two actions. It is
  lifecycle, like `shells` itself, and it is never persisted: a parked
  line dies with the app, as a pty does.
- The parked line reaches whichever terminal opens next, which may not be
  the one the user expected if they open one by hand at the same moment.
  The command is echoed where it ran, so it is visible either way.
- `!` while the agent is working runs immediately instead of queueing
  behind the turn, which is the point — the shell has nothing to do with
  the agent's busy flag.
- A prompt that starts with `!` needs a leading space. Cheap, but it is a
  rule someone will meet by surprise once.
- The composer tints a `!` line in the tool colour so which of the two
  readers is about to get it is visible before Enter, not after.

## Addendum — the suggestion comes along too

ADR-0009's greyed-out completion belongs to a `!` line as much as to the
terminal, and it is the same ranked history either way: a command learned
in one place is offered in the other, including the ones `runLine` itself
ran.

The terminal is *pushed* its suggestion, through the `onSuggest` callback
its session was opened with. The composer has no session — and before the
first terminal opens, no history has been read at all — so it **asks**
instead: `Shells.suggestFor(prefix)`, which warms the history the same
lazy way and returns the suffix to draw. The history stays private to the
use case for the reason above: through the reducer it would re-render the
workbench once per keystroke.

Two keys accept it, and which two is the one thing borrowed from Warp
rather than from our own terminal. Warp's inline history suggestion and
its completions dropdown coexist because their accept keys differ, so:

- **Right arrow**, from the end of the line only — anywhere else it has a
  caret to move, exactly as in the terminal.
- **Tab**, but only while nothing is greyed in *and* no menu is open. The
  `/` and `@` menus keep Tab and Enter whenever they are showing, and the
  suggestion hides while they are: two guesses on screen at once is a
  question about which key the user meant.

`shellPrefix` exists for this and not for running: it strips the bang and
the space after it but **keeps trailing space**, because a suggestion is
drawn past the caret and so has to be predicted from a prefix that ends
exactly where the caret does. Predicting from a trimmed `git` while the
draft reads `!git ` comes back one space too wide.

Not taken: a dropdown of matching history lines, and Warp's other half —
completion of arguments and paths from command specs. Both are much
larger features, and the point of this one is that the ranking, the
corpus and the accept keys were all already here.
