# ADR-0016 — Rewind checkpoints

- Status: accepted
- Date: 2026-08-18
- Extends: ADR-0005 (interactive agent sessions over ACP)

## Context

A turn that goes wrong is unrecoverable. Mota had no checkpoint,
snapshot, undo or restore anywhere: `git.rs` exposed reads and additive
verbs only — no `stash`, no `reset`, no `restore` — and there is no
editor buffer to undo in, because agent writes land on disk (either
through `acp_session`'s `fs/write_text_file` handler or through the
agent's own tools, which Mota never sees). The only way back was by hand.

Claude Code solves this with `/rewind`, and the machinery is right
there: `@anthropic-ai/claude-agent-sdk` exposes
`Query.rewindFiles(userMessageId)` and an `enableFileCheckpointing`
option, backed by a content store at `~/.claude/file-history/`.

It is not reachable from here. `@agentclientprotocol/claude-agent-acp`
— the adapter Mota actually spawns — deliberately does not wire it up.
Its own `acp-agent.d.ts` says so, on the table that maps ACP message ids
to the SDK uuids rewind keys on:

> NOT READ YET — recorded now so the mapping exists if/when we wire up
> fork/rewind.

The only extension methods it exposes are `_claude/origin`,
`_claude/rateLimit`, `_claude/sdkMessage` and
`_claude/askUserQuestionOption`. None of them rewinds anything. Waiting
for the adapter would also buy a Claude-only feature, when the same gap
exists for codex and gemini.

## Decision

Mota takes its own checkpoints, backed by **git objects**, and `/rewind`
restores **files only**.

### Why git objects

A checkpoint is a commit built from a throwaway `GIT_INDEX_FILE`:
`read-tree` the parent, `add -A`, `write-tree`, `commit-tree`. Nothing
is committed to a branch and the user's own index, HEAD and
staged/unstaged split are untouched — a test asserts exactly that.

- **No new dependency.** git is already a hard requirement and already
  shelled out to from `git.rs`.
- **It catches writes Mota never hears about.** The alternative was
  reverse-applying the `oldText` already recorded on every agent `diff`
  tool call (`agentEditedFiles` in `core/entities/tool.ts`). That data
  is free, but it only covers edits the agent *reported*: a
  `printf … > f.txt` in a Bash tool call is invisible to it. Git sees
  the tree, so it sees everything.
- **It is content-addressed.** Two checkpoints of a mostly-unchanged
  tree share every blob, so the chain costs close to nothing.
- **`.gitignore` is the right filter, already written.** No checkpoint
  ever snapshots `node_modules/`.

Each checkpoint parents the previous one and a single ref per
conversation — `refs/mota/checkpoints/<session>` — anchors the chain, so
`git gc --prune=now` cannot collect a checkpoint the user can still see.
That is a test too.

Restoring compares the checkpoint against **a tree of the present**,
built the same way, rather than against the work tree. `git diff
<commit>` alone ignores untracked files, so a file the agent created
would not be reported as added and would survive a rewind — the app
saying the code went back while it had not. Both sides go through the
same `add -A`, and the comparison is symmetric.

`--no-renames` is deliberate. With rename detection on, one entry pairs
a path to restore with a path to delete, and the delete list is the one
that must stay boring. Only files git reports as `A` are ever removed;
an unrecognised status restores rather than deletes.

A folder that is not a git repository gets no checkpoints. `SendPrompt`
asks once, remembers the failure, and every turn after that skips
straight past — a prompt must not pay for a subprocess that cannot
succeed. Those turns simply do not appear in the picker.

### Why files only

Truncating the transcript is easy; truncating the *agent's* memory is
not. ACP has no "forget everything after this message", and the only
thing that comes close — starting a fresh session — loses the whole
conversation, which is a bigger loss than the one being undone.

So the conversation is left exactly as it is, and the transcript notice
says so in as many words:

> The conversation is unchanged, so the agent still believes it made
> those edits — tell it what you undid.

That is the one way this feature can mislead, so it is stated rather
than implied.

### Cost

The snapshot has to be awaited: one taken after the agent's first edit
records the damage instead of the state before it. So the only lever is
how long the user waits, and `CHECKPOINT_BUDGET_MS` (3s) is the cap. A
repository too big to stage in that time sends the prompt anyway, with
no rewind point — a turn that cannot be rewound is better than a
composer that stalls behind git.

## Consequences

- A bad turn is one dialog away from being undone, for every provider,
  including edits made through the shell.
- Rewinding is itself undoable: the restore takes its own checkpoint
  first, on a separate ref so clearing a chat cannot take it away, and
  the bar above the composer offers it back.
- A restore runs git's checkout filters, so on a machine with
  `core.autocrlf=true` a restored file comes back with CRLF — exactly
  what `git checkout` would have done, and the reason the tests pin
  `core.autocrlf=false` rather than depend on the machine.
- Checkpoint commits accumulate in the object database. `/clear` drops
  the chat's ref, and unreachable objects are `git gc`'s business from
  then on.
- Should the ACP adapter ever expose `rewindFiles`, this does not need
  to move: it would be a second `CheckpointPort` adapter, and the use
  case would not change.

## Alternatives rejected

- **Reverse-applying reported diffs.** Free, and works without git, but
  blind to anything the agent did through a shell. Rejected as the
  primary; rejected as a fallback too, because a restore that silently
  misses half a turn is worse than one that says it cannot run.
- **A Mota-owned snapshot store** (copy files aside, like
  `~/.claude/file-history/`). Works without git, but Mota cannot know
  which files a turn will touch before it runs, so it must either copy
  the whole tree or miss the same shell writes.
- **`git stash`.** Touches the work tree and the user's stash list, and
  does not include untracked files without extra flags. A checkpoint has
  to be invisible.
