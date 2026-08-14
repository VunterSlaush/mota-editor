# Editable tab names and colour codes

**Status:** design approved, not yet implemented
**Date:** 2026-08-12

## Purpose

Group tabs by task. A colour marks tabs that belong to the same piece of
work regardless of which repository they point at; a name says what the
task is, where the folder's basename says only where it lives.

The colour is a grouping signal shared across tabs. The name is per tab.
Neither is a group object the app knows about — two amber tabs mean the
same task to the user, and the app stores only "this tab is amber". That
keeps the change to two optional fields with no new entity, no CRUD, and
no management UI.

## What this is not

- Not Chrome-style tab groups. No group entity, no collapsing, no
  close-a-group.
- Not a free colour picker. The palette is a closed set of seven.
- Not a change to tab identity. A tab is still its path.

## Data model

### `src/core/entities/tabColor.ts` (new)

```ts
export type TabColorId =
  | "red" | "amber" | "green" | "teal" | "blue" | "violet" | "grey";

export const TAB_COLORS: readonly { id: TabColorId; label: string }[];

export function isTabColorId(value: string): value is TabColorId;
```

The core stores only the id. The values live in CSS as `--tab-color-<id>`,
following the pattern `entities/theme.ts` already documents: "The palette
itself lives in CSS under `[data-theme]`".

`isTabColorId` exists so a workspace file written by a newer build — or
hand-edited — degrades to *no colour* rather than to an undefined CSS
variable.

### `Project` gains two optional fields

```ts
/** The name the user gave this tab; `name` stays the folder's. */
readonly label?: string;
/** Grouping colour, an id from entities/tabColor. */
readonly color?: TabColorId;
```

Both absent-when-unset rather than present-holding-`undefined`, the rule
`mcpOverrides` and `provisioningOverride` already follow: a key that
exists reads as a decision that was made.

`label` is a separate field rather than a mutation of `name` because
`name` is **derived from the path on every restore**
(`restoreWorkspace.ts:35` calls `projectNameFromPath`). A name written
into `name` would be silently recomputed away on the next launch.

### One accessor, in `project.ts`

```ts
export function tabLabel(project: Project): string {
  return project.label ?? project.name;
}
```

So every caller asking "what is this tab called" gets one answer.

## Reducer

Two actions, named like the existing `tab/modeChanged` family:

- `tab/labelChanged { tabId, label: string }`
- `tab/colorChanged { tabId, color: TabColorId | undefined }`

The label is trimmed and capped at **60 characters** in the reducer — that
is where the invariant belongs and it stays pure. Sixty is well past what
the strip can show (it ellipsises at `max-width: 220px`) and far short of
anything pathological reaching the workspace file. An empty or
whitespace-only label, and an `undefined` colour, **delete the key**
rather than storing a blank.

A label never touches `project.name`.

## Use cases

`src/core/usecases/tabIdentity.ts` (new), holding `RenameTab` and
`RecolorTab`. Each is the same four lines as `SelectVerbose`: dispatch,
then `persistWorkspace`. A noun-named use-case file matches the existing
`worktrees.ts`, `shells.ts`, and `sessionStatus.ts`.

## Persistence

`PersistedProject` gains `label?` and `color?`. `toPersisted` writes both.
`restoreWorkspace` reads `label` straight through and puts `color` through
`isTabColorId`. Old workspace files load untouched — every field in
`PersistedProject` is already optional.

## Worktree inheritance

A worktree opened from a coloured tab **inherits the colour but not the
label**. A worktree forked from a task tab is that task, so the group
forms itself; two identically-named tabs would be worse than one unnamed
one.

`ProjectDefaults` gains `color?`, and `worktrees.open` passes
`source?.project.color` explicitly alongside `provisioningOverride` —
**outside** the `inheritFromSourceTab` branch. There is precedent for
travelling regardless of that toggle (`worktrees.ts:97`), but the reason
differs and the comment must say so: that toggle governs *agent* settings
(provider, model, permission), and a grouping colour is not one.

## The wash

The colour renders as a flat low-opacity wash of the whole tab. This
splits the two signals the tab carries: **saturated and small is status**
(the dot), **faded and large is identity** (the colour). Status also
expresses itself through text colour and weight, which a background wash
does not touch.

```css
.tab[data-color]         { background: color-mix(in oklab, var(--tab-wash) 12%, var(--bg-raised)); }
.tab--active[data-color] { background: color-mix(in oklab, var(--tab-wash) 22%, var(--bg)); }
.tab[data-color="amber"] { --tab-wash: var(--tab-color-amber); }
```

A **data attribute, not an inline style**. This matters for performance:
the attribute is byte-identical between renders when the colour has not
changed, so React skips the write and the engine skips style
invalidation. An inline style object is fresh every render and forces a
style recalc on that element each time. `data-color` also gives "is this
tab coloured at all" as a presence selector for free.

The active tab mixes *more* colour into `--bg` while inactive tabs mix
*less* into `--bg-raised`, so the hue and the "you are here" contrast both
survive — the app's active-tab signal is itself background-based.

The seven hues are defined **once** in `oklch()` with fixed hue and
chroma; the mix against each theme's own background supplies the
lightness. Per-theme overrides are added only where one actually looks
wrong. Seven declarations, not seven times eight.

### The density payoff

At `icons` density every inactive tab loses its name, but a background
survives — so the colour becomes the tab's only identity at exactly the
moment the text is gone. No extra code; it falls out of the CSS already
there.

## Name display

The custom name **replaces** the folder name in the strip. The folder name
and full path stay in the hover tooltip, so nothing is lost — just moved
one hover away — and it costs no width in a strip that already sheds
content at three density levels.

The tooltip becomes `label — path (branch)` when labelled and keeps the
existing `path (branch)` when not, with the status suffix unchanged.

The branch chip is untouched: it answers "which checkout", which is a
different question and is already density-managed.

### Where a label replaces a folder name

| Site | Shows |
|---|---|
| `TabBar.tsx:71` tab name | label |
| `TabBar.tsx:79` close `aria-label` | label |
| `SettingsUsage.tsx:238` per-tab usage row | label |
| `SettingsTools.tsx:221` "In {name}: on/off" | label |
| `SettingsWorktrees.tsx:133` "In {name}" | label |
| `sendPrompt.ts:596` OS notification "… finished — {name}" | label |
| `ChatPanel.tsx:571` "Ask Claude about {name}…" | **folder name** |

The composer placeholder is the exception: it names the *codebase the
agent can see*, not the tab. "Ask Claude about auth rewrite" would
misdescribe the agent's scope.

## `TabMenu.tsx` — the popover

Right-click a tab for a popover carrying both fields: a text input, a row
of seven swatches plus a "none" swatch that clears the colour
(`RecolorTab` with `undefined`), and a "Reset to folder name" row — which
clears the label, and is shown only when a label is set.

- Opened by `onContextMenu` with `preventDefault()` — required, or
  WKWebView draws its own menu on macOS.
- It **cannot** render inside the tab: `.tab` has `overflow: hidden` and
  would clip it. It renders at `TabBar` level, fixed-positioned from the
  tab's `getBoundingClientRect()`.
- It reuses **`tooltipPlacement(host, tip, viewport)`** unchanged.
  "Below, flipped above when it doesn't fit, clamped inside the window" is
  exactly the requirement, and that function is already pure and already
  unit-tested.
- Conventions borrowed from `OptionPicker`: document `mousedown` outside
  closes, Escape closes, arrows and Enter work the swatch row.
- The input takes focus on open, so right-click → type → Enter is the
  whole rename gesture.

### The input holds its draft in local state

**Enter and blur commit. Escape reverts.** The popover keeps the
half-typed name in local component state and dispatches `RenameTab`
exactly once, on commit.

This is not a micro-optimisation. `persistWorkspace` serialises the
**entire workspace** and writes it to disk through Tauri IPC. An
`onChange` that dispatched per keystroke would mean one full
serialise → IPC → `fs::write` per character — roughly eight writes a
second of a 4–8 KB file while typing a name. Commit-on-blur makes it one
write per rename. A colour swatch is a single click and needs no such
handling.

Because commit is deferred, Escape-reverts-the-draft has to be explicit:
Escape means cancel.

### Right-click does not activate the tab

`contextmenu` does not fire `click`, so the existing `onSelect` never
runs. A background tab can be recoloured without leaving the current
work — the platform convention, and the right behaviour for a grouping
gesture.

`useDragReorder.ts:35` already guards this from the other side:
`if (e.button !== 0) return; // a right-click is a menu, not a drag`.

## Resource cost

Estimates, not measurements — reasoned before implementation.

**RAM.** Two fields per project ≈ 100–150 B per tab, so ten tabs ≈ 1.5 KB.
The `TAB_COLORS` catalog is under 1 KB once. Seven CSS custom properties
declared at the root are inherited by reference, not copied per element
(true in both WKWebView and WebView2, which matters because Tauri uses
the platform webview). The popover is roughly fifteen DOM nodes while
open and **zero when closed**. Steady-state total is well under 10 KB
against a webview baseline of 100–300 MB.

**CPU.** Zero at rest: no new timers, animations, or observers — the
`ResizeObserver` for density already exists and is untouched. Per render
it is one `??` and one attribute per tab. `color-mix()` resolves at style
resolution, not per frame. React delegates `contextmenu` at the root, so
N tabs is not N listeners; the one document `mousedown` listener exists
only while the popover is open.

**The only real cost** is the per-keystroke disk write, which the
commit-on-blur design above removes.

**Context worth knowing:** `TabBar` re-renders on every store dispatch,
and `chat/assistantDelta` dispatches per streamed token — so the strip
already re-renders dozens of times a second during any turn. That
pre-existing cost dwarfs everything this feature adds. It is out of scope
here and deliberately not addressed.

**To confirm once built:** RSS before/after with ten coloured tabs, and a
React profiler pass on a streaming turn comparing the strip's commit
duration with and without colours set.

## Tests

Test-first, one concept each, framework-free.

- `tabColor.test.ts` — known ids accepted; unknown and empty rejected.
- `project.test.ts` — `tabLabel` prefers the label, falls back to the
  folder name; `defaultsFromProject` carries the colour but not the label.
- `appState.test.ts` — label set; whitespace-only label clears the key;
  over-long label capped; colour set; `undefined` colour clears the key; a
  label never overwrites `project.name`.
- `restoreWorkspace.test.ts` — a persisted label survives while `name` is
  still recomputed from the path; an unknown colour id restores as
  uncoloured; a file with neither field loads.
- `persistWorkspace` — `toPersisted` carries both fields.
- `worktrees.test.ts` — colour inherited from the source tab; label not
  inherited; **colour inherited even with `inheritFromSourceTab` off**.
  That last one guards the deliberate decision a future reader is most
  likely to "fix" by assuming the toggle governs everything.
- `tabIdentity.test.ts` — each use case dispatches and saves once.

### Known gap

The popover component and the CSS are not tested, by the same deliberate
trade `ARCHITECTURE.md` already documents for humble views. This means
the commit-on-blur invariant — one disk write per rename, not per
keystroke — has **no automated guard**. The only reviewable evidence is
the absence of a dispatching `onChange`.

## Edge cases

- **Tab identity stays the path.** `tab/opened` dedupes on `project.path`
  and `worktrees.open` uses `samePath`. The label is cosmetic and must not
  join either check.
- **Duplicate labels are allowed.** A uniqueness rule would buy an error
  surface and nothing else.
- **The label leaves the webview in exactly one place** — the OS
  notification title. Everywhere else it is text in the DOM, which React
  escapes; it never becomes a path, a shell argument, or part of an agent
  prompt. Tauri's notification API takes it as data, not a command, so
  there is no injection surface.
- **Transcripts are keyed by session id and project path**, so renaming
  never orphans or renames a stored conversation.
- **Accepted overlap:** the palette includes red, amber and green, which
  the status dot also uses. A red-coloured tab showing a red error dot is
  momentarily ambiguous. The wash is desaturated and the dot is saturated
  with a glow, so the weights differ. Dropping three useful hues would
  cost more than it fixes.

## Decisions and their reasons

| Decision | Why |
|---|---|
| Bare colours, no group entity | Grouping is emergent; a group object needs CRUD and UI for no added signal |
| Named ids, values in per-theme CSS | Three of the eight themes are light; a hardcoded palette would be muddy on them |
| Flat low-opacity wash | Splits identity from status without competing with the active-tab background |
| `label` separate from `name` | `name` is recomputed from the path on every restore |
| Custom name replaces the folder name | The strip sheds content at three density levels; the tooltip is the escape hatch |
| Colour inherits to worktrees, label does not | A forked worktree is the same task; duplicate names are worse than none |
| Right-click popover, both fields | One component, one place, matches the platform convention for tabs |
| Commit on blur, not on change | One disk write per rename instead of one per keystroke |

## No ADR needed

No new dependency, no new boundary, no new process. The change adds two
optional entity fields, two reducer actions, one use-case file, and one
component, all inside existing layers.
