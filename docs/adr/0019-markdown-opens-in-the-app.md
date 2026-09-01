# ADR-0019 — Markdown opens in the app; everything else still leaves

- Status: accepted; supersedes ADR-0016's "clicking a file leaves the app" for
  markdown only
- Date: 2026-09-01
- Relates to: ADR-0016 (the file tree), ADR-0017 (the disk is the listing),
  ADR-0001 (lightweight is the product)

## Context

ADR-0016 settled that clicking a file in the tree hands it to the OS, and
listed "an in-app editor or viewer" under alternatives considered: *that is a
different product*. That reasoning holds for a `.ts` file. It does not hold for
a `README.md`.

Markdown is the one kind of file this app already knows how to display. The
renderer shipped for agent output — `MarkdownLite.tsx`, react-markdown plus
remark-gfm, with links and remote images already defanged — has been in the
transcript since the beginning. A `.md` file is also the kind you most often
want to *read* rather than edit: a README, an ADR, an AGENTS.md, a plan the
agent just wrote. Sending it to the OS opens a second window for something the
app could have drawn in place, and the file the user came back to check is now
behind the one they were working in.

The cost of the exception is small and bounded: no new dependency, no new
window, no editing, no per-file tabs.

## Decision

- **Markdown renders here; every other kind still leaves.** `rendersInApp` in
  `entities/fileTree.ts` is the single seam that decides, expressed on top of
  the existing `fileKind`. One predicate, one test, and the next kind that
  earns an in-app view (images are the obvious candidate) is an edit to it
  rather than a new branch at each call site.
- **Read-only, and the escape hatch stays one click away.** The viewer's header
  carries "open in the default app", which is exactly the old behaviour. This
  adds a way to read a file; it removes none.
- **The rest of the OS integration moves to a secondary click.** A left click
  is one action and cannot be three, so the file rows grew a context menu:
  Open, Open with…, and Show in the file manager. It is the standard place to
  look for exactly these, and it keeps the default click a single decision.
  `open_path_with` and `reveal_path` join `open_path` as siblings, all three
  resolving their argument through one `project_file` — the confinement that
  used to live inside `open_path` alone.
- **"Open with" is Windows-only, and says so by not being there.** Windows has
  a chooser reachable from a command line (`shell32.dll,OpenAs_RunDLL`);
  macOS and the Linux desktops keep theirs inside the file manager. The menu
  leaves the item out where it cannot work rather than offering one that always
  fails, and the backend refuses it too rather than silently opening the
  default app and calling that a choice. Both platforms still reach the real
  chooser through "Show in…", which is one item down.
- **A modal, not a tab.** Tabs are one per project (ADR-0016, `TabBar.tsx`) and
  a per-file tab system is the editor this app is not. The modal follows the
  diff and plan modals already there: centred, Escape or click-outside to
  close, resizable by the bottom-right grip.
- **A new command, confined like every other outside-supplied path.**
  `read_project_markdown` joins the project-relative path to the root and hands
  it to `fs_confine::confine_to_project`, the shared helper the ACP agents and
  the extension host already use, so the confinement rule cannot drift between
  them. It then re-checks the extension and refuses anything over
  `MAX_MARKDOWN_BYTES` (2 MiB). The frontend check picks the viewer; the
  backend check is the one that means anything.
- **No generic `read_file`.** Every `fs::read_to_string` in `src-tauri` is
  purpose-scoped, and this one stays that way. A command that reads any file in
  the project is a larger decision than a markdown viewer needs to make.

## Consequences

- Clicking a `.md` no longer opens the user's editor. For the reading case that
  is the point; for the editing case it is one extra click on a button that
  says so, or a secondary click on the row. If that grates, the fix is a
  modifier-click, not a preference.
- The context menu is on files only. Folders have none of the three actions —
  "Open" and "Open with" are meaningless for one, and revealing a folder is a
  want nobody has stated. Adding them later is an `onMenu` on the folder branch
  of the same row component.
- "Show in…" selects the file on Windows and macOS and merely opens its folder
  on Linux, where no two desktops agree on how to select one. The menu item is
  named for what it does everywhere.
- The size cap is a hard refusal with a message, not a truncation: a 2 MiB
  markdown file is a generated artifact, and half of one is worse than none.
- The viewer inherits `MarkdownLite`'s security posture, which was written for
  untrusted agent output and is therefore stricter than a project's own files
  need — remote images render as links rather than loading. Stricter is the
  right direction for a file that a `git pull` can change.
- Three modals now share `useResizableModal`; the drag arithmetic that was
  copied between the diff and plan modals is stated once, including the
  centred-versus-top-anchored difference that made the two copies differ.
- Panel state (which file is open) stays local to `FilesPanel`, like the
  expanded folders beside it: switching tabs closes the viewer.

## Alternatives considered

- **A per-file tab system.** The editor this app declines to be. Tabs mean
  dirty state, save, and a text buffer; none of that is needed to read a
  README.
- **Rendering in the right-hand plan panel.** It would put a project file in
  the surface that means "what the agent is doing", and the two would fight
  over one slot.
- **A generic text viewer for any file.** Tempting, and the reason to stop at
  markdown is that markdown is the only kind the app can display *better* than
  the OS would. A `.ts` file in a modal with no syntax highlighting, no search
  and no editing is worse than the editor already installed.
- **Preview on hover, or a preview pane under the tree.** More surface, more
  state, and it answers a question ("what is in this file?") that the modal
  answers with one click and one Escape.
