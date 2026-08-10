# ADR-0008 — Worktree provisioning, removal, and what a worktree costs

- Status: accepted
- Date: 2026-08-09
- Amends: ADR-0007 (git worktrees as tabs)

## Context

ADR-0007 made a worktree cost 2 MB of git checkout. Measured on this
repository, a *usable* worktree costs 5.1 GB: `src-tauri/target` is
4.9 GB and `node_modules` is 240 MB, and git carries neither. Three
parallel worktrees meant ~15 GB and three cold builds — which undercuts
the reason worktrees exist here. ADR-0007 also deferred removal, so
nothing ever gave that space back.

Worktrees also had no configuration at all: the container path, the
`origin` remote, and the fact that a new worktree tab was seeded from
global defaults rather than the tab it was forked from were all
hardcoded.

## Decision

### Provisioning is a configurable list, with two strategies

`AppSettings.worktrees.provisioning` is a list of repository-relative
folders, each `share`, `clone`, or `skip`. Defaults: `node_modules` →
`clone`, `src-tauri/target` → `skip`.

The two strategies are not interchangeable, and the reason is
**ADR-0005's `confine_to_project`**: it canonicalizes every path the
agent asks for and requires it to stay inside the project. A shared
folder is a link *out* of the worktree, so terminal build tools resolve
it fine and the agent's own reads are refused. Therefore:

- `share` is for build output the agent never reads (`target`, `dist`).
- `clone` is for anything the agent greps (`node_modules`, `vendor`).
  A pure `shareRisk()` in the entities layer says so in the settings row
  rather than leaving it to be discovered as "the file does not exist".

`src-tauri/target` defaults to `skip` rather than `share` because two
worktrees sharing one target directory serialize on cargo's build lock —
destroying the parallelism the worktree was for. Where the filesystem
clones, `clone` is strictly better than both.

### Copying shells out; linking does not

Copy-on-write is the whole point, and no Rust crate reaches it: APFS
clones a *whole directory* in one `clonefile` syscall. So copying shells
out to the platform's own tool — `cp -c` (macOS, retried without `-c`),
`cp -a --reflink=auto -T` (Linux), `robocopy` (Windows, where **exit
codes 0–7 are successes**). Linking uses `std::os::*::fs::symlink*`,
because that syscall *is* in std.

The rule: **shell out only where the syscall is not in std.** This
extends ADR-0002's shell-out-to-the-official-tool stance;
`runner::os_command` spawns a resolved binary with an argv vector and
never a shell, and paths are app-derived absolutes passed after `--`.

Measured here: cloning a 200 MB tree cost 12 KB of real disk.

**Bind mounts are deliberately not implemented.** They need root, do not
survive a reboot, and — decisively — a mount point `lstat`s as a real
directory, so removing the worktree would recurse *through* it and
delete the main checkout's copy.

### Provisioning never gates worktree creation

`git worktree add` succeeds → the tab opens → the picker closes.
Provisioning is fired without `await`; per-folder failures come back as
outcomes inside an `Ok` report, never as a rejected call. The tab shows
a "Preparing…" chip, then a clickable "Not prepared" that retries — the
whole operation is idempotent, so retry is the same call.

Progress rides its own Tauri channel, not `AgentEvent`: that enum is the
agent's vocabulary and has no business learning about disks.

### Removal closes the tab first, and unlinks before it deletes

`RemoveWorktree` takes `CloseProject` as a dependency rather than
repeating it, and the order is load-bearing: a mid-turn agent is writing
into the folder, and `endSession` → `AcpSession::shutdown` →
`terminals.kill_all()` releases the children whose working directory is
inside it. On Windows an open handle makes the delete fail outright.

```
close the tab → unprovision → git worktree remove → git worktree prune
```

**Does removing a worktree whose `node_modules` is a symlink delete the
main checkout's `node_modules`? No.** `git worktree remove` ends in
`dir.c:remove_dir_recurse()`, which `lstat`s each entry; a
symlink-to-directory reports `S_ISLNK`, never `S_ISDIR`, so git unlinks
it rather than descending, and POSIX `unlink()` never follows a symlink.
The same reasoning covers `rm -rf` and `git clean -dfx`.

We un-provision first anyway, on every platform. The guarantee is sound
but rests on one `lstat` in someone else's code, and Windows directory
reparse points have a long tail of tools that get it wrong. The gate is
the pure, unit-tested `should_unlink`, which is true only for a symlink —
a real directory is the worktree's own and is left for git.

`git_worktree_remove` also *verifies* rather than merely validates: the
path must be one of the checkouts git itself lists, and not the main one.
Without that, any absolute path handed to the command is a recursive
delete.

### Disk is reported by provenance, not measured

APFS and btrfs attribute shared extents to every clone, so `st_blocks`
reports a copy-on-write clone at full size — `du` has the same bug, and
measuring true exclusive ownership would mean per-extent walking of
millions of files. So the folders we linked or cloned are counted into
`sharedBytes` and the rest into `ownBytes`, and the UI says "5.1 GB ·
4.9 GB shared with the main checkout". Recording what we did is honest;
claiming to have measured sharing would not be.

## Consequences

- The pure half (`validate_entry_path`, `plan_step`, `should_unlink`,
  `roll_up`, `remove_args`) lives in `agent_core::worktree` and is unit
  tested; the shell half in `src-tauri/src/worktree.rs` only probes and
  acts. The removal *policy* (`removalCheck`) lives in TS core, where the
  use case composes it — one language, not two.
- Nothing that holds data is ever deleted to make room: an occupied
  target is a conflict the user resolves. A link we did not create is
  never rewired, because that would silently move where someone else's
  build reads from.
- The dirty check is `git status` on the worktree, so the app's verdict
  and git's come from the same command. Ignored files never appear in
  either — the heavy folders can never be what provokes `--force`.
- Branch deletion after removal is out of scope. `git worktree remove`
  deliberately leaves the branch, and conflating the two loses work.
- Sharing a folder makes it invisible to the agent. That is inherent to
  ADR-0005's confinement, not a bug to fix here; the settings row warns.
- Untested by `npm test` and left to a per-OS pass: that `cp -c` really
  clones, robocopy's exit-code mapping, Windows symlink privilege,
  `st_blocks` on clones, and that git unlinks rather than follows a real
  symlink — the last being where data loss would live if the analysis
  above is wrong.
