# ADR-0016 — A file tree in the sidebar, listed by git first

- Status: accepted; the listing decision superseded by ADR-0017 (the disk is
  the listing, ignored files included)
- Date: 2026-08-21
- Relates to: ADR-0013 (declarative sidebar panels — the slot this fills),
  ADR-0001 (lightweight is the product)

## Context

The sidebar shows the repository's changes, its worktrees, its sessions and
its subtasks — everything about the project except the project. The only file
list in the app was the composer's "@" menu: flat, transient, and gone the
moment you stop typing. Looking at a file meant leaving for a file manager.

A tree needs a listing, and a listing needs an answer to "which files?". Every
project already has one: `git_list_files` runs
`git ls-files --cached --others --exclude-standard`, which the "@" menu has
used since it shipped.

## Decision

- **Git is the listing.** `.gitignore` is the ignore rule the user already
  maintains, and git applies it — plus `.git/info/exclude` and the global
  excludes — faster than we could walk the disk. `node_modules` and build
  output stay out of the tree for free, and this app ships no ignore rules of
  its own to drift from the ones the repository states.
- **The disk is the fallback, not the source.** A folder that was never a
  repository would otherwise show an empty tree of the user's own files. A new
  `ProjectFiles` port (`list_folder_files` in `src-tauri/src/project_files.rs`)
  walks it, skipping the same heavy folders `worktree::OPAQUE_FOLDERS` refuses
  to look inside, under the `MAX_PROJECT_FILES` cap the git listing already
  respects. `ListProjectFiles` owns the choice between the two, so the "@" menu
  gains non-repository folders from the same change.
- **Falling back on an empty answer, not on a repository probe.** No separate
  "is this a repo?" call: git answering with nothing is the signal. The one
  case this reads wrong — a repository in which every single file is ignored —
  falls through to the disk and shows those ignored files. Showing them beats
  showing nothing, and asking git twice to be right about a case nobody has
  is the worse trade.
- **The tree is shaped in the core.** `entities/fileTree.ts` folds the flat
  paths into nodes (`buildFileTree`) and picks the rows on screen
  (`visibleRows`), as two pure functions with no I/O, tested without a browser.
  Splitting them is what keeps a 20 000-path project responsive: opening a
  folder re-walks the tree without re-sorting it.
- **Clicking a file leaves the app.** `open_path` already hands a file to the
  OS, confined to the project folder; the panel reuses it untouched. Folders
  only expand — `open_path` rejects them by design.

## Consequences

- One new port, one new Tauri command, no new dependency and no new
  permission: the opener and the git listing were both already there.
- The tree can only show what the listing shows. An ignored file — `.env`,
  something under `dist/` — is not in it, and in a repository there is no
  toggle to reveal it. That is the cost of not maintaining ignore rules, and
  it is the right one until someone needs the opposite.
- Panel state (which folders are open) is view state in the component, like
  the Changes panel's sections: switching tabs collapses the tree. Lifting it
  into `App.tsx` beside the per-project sidebar selection is the escape hatch
  if that ever grates.
- The 20 000-file cap truncates git's output before anything sorts it, so a
  monorepo at the cap shows a partially populated folder with no sign that it
  did. Out of scope here; worth knowing before someone debugs it.

## Alternatives considered

- **Walking the disk for every project**, with our own ignore list. It would
  show ignored files, which nobody asked for, and would put this app in the
  business of maintaining a list that `.gitignore` already states per project.
- **Lazy per-directory listing** (read a folder when it is opened, as a file
  manager does). Justified at a scale git's flat listing does not reach: one
  `ls-files` already returns the whole project in a single call, and 20 000
  strings is nothing to fold in memory.
- **An in-app editor or viewer.** That is a different product. The OS already
  knows which app opens a `.ts` file, and this one drives agents.
