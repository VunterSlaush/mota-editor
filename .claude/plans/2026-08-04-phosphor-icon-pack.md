# Adopt Phosphor Icons across the mota-editor UI

- **Linear issue:** none — task started ad hoc from a `/start-task` invocation with no issue URL.
- **Branch:** none. `G:\mota-editor` is not a git repository, so the branch step was skipped.
- **Date:** 2026-08-04

## Goal

Replace the ad-hoc mix of color emoji and Unicode glyphs currently standing in for
icons with a single coherent icon set — **Phosphor** (`@phosphor-icons/react`,
v2.1.10, MIT) — so the workbench reads as a deliberate product rather than a
prototype, and so icons participate in the theme (`currentColor`, `--text-dim`,
`--accent`) instead of ignoring it.

## Current state (audited 2026-08-04)

No icon dependency exists. Icons today are three unrelated things:

| Kind | Sites | Glyphs |
|---|---|---|
| Color emoji | `ActivityBar`, `Composer`, `MessageList`, `PlanPanel` | 🕘 📎 📋 ⚡ 🛡 🔐 |
| Unicode symbols | `ChangesPanel`, `Composer`, `PlanPanel` | ⚙ ▾ ⇣ ⇡ ⟳ ✓ − + ↑ ■ ⏵⏵ ☑ ☐ × |
| Hand-rolled SVG | `ContextGauge.tsx:28` | context-usage donut |

Three defects this causes:

1. **`ActivityBar.tsx:9` has an empty icon string** — `{ view: "changes", icon: "" }`.
   The source-control button renders no glyph at all today.
2. **Emoji are platform fonts.** On Windows they resolve to Segoe UI Emoji color
   glyphs — glossy and off-scale against the flat `#14161a` chrome. They cannot
   inherit `currentColor`, so they never dim to `--text-dim` or highlight to
   `--accent`.
3. **Two icons sit inside `<option>` elements** (`Composer.tsx:232` mode picker,
   `Composer.tsx:246` permission picker, and the shared `OptionPicker.tsx`).
   Native `<select>` options cannot render SVG under any icon library.

Design constraints to respect: dark-only (`color-scheme: dark`), `--accent:
#4f8cff`, Segoe UI at 14px base, VS-style shell. Tauri app, so the set must
bundle offline — no CDN icon fonts. Icons are strictly UI-layer, so this
dependency does not touch `core/` and does not violate the Dependency Rule in
`docs/ARCHITECTURE.md`.

## Why Phosphor

Chosen by the user from a field of Lucide, Radix Icons, Codicons, Tabler, and
Iconify. The deciding factor: Phosphor ships **six weights** (thin, light,
regular, bold, fill, duotone) of the same ~1,500 icons. The `weight` prop gives
active/inactive state as a free axis — `regular` when idle, `fill` when active —
which the activity bar currently expresses with nothing but a CSS class.

## Acceptance criteria

1. `@phosphor-icons/react` is a production dependency; no other icon library is added.
2. Every emoji and Unicode-glyph icon in `src/ui/components/` is replaced by a
   Phosphor component, **except** those documented under "Out of scope" below.
3. The source-control item in `ActivityBar` renders a real icon (bug from
   `ActivityBar.tsx:9` fixed).
4. Icons inherit theme color — an icon in a dimmed control is `--text-dim`, an
   active activity-bar item is `--accent`.
5. Activity-bar items use `weight="fill"` when active and `weight="regular"` otherwise.
6. Icon size and default weight are set in one place, not repeated per call site.
7. `npm run typecheck` and `npm run test` both pass.
8. *(Inferred — not stated by the user)* Every icon-only button keeps its existing
   `aria-label`/`title`. Phosphor renders `<svg>` with no accessible name of its
   own, so removing those would regress screen-reader support.

## Suggested approach

Single package — `src/ui/` only. No `core/`, `adapters/`, or `src-tauri/` changes.

1. **Install** — `npm install @phosphor-icons/react`.
2. **Set defaults once.** Wrap the app in Phosphor's `IconContext.Provider` in
   `src/ui/App.tsx` with `{ size: 16, weight: "regular" }`. This is preferable to
   writing a local `<Icon>` wrapper component: it is the library's own mechanism,
   and it keeps call sites down to a bare `<GitBranch />`. Call sites override
   per-icon only where they genuinely differ (activity bar at 20px, for instance).
3. **Migrate component by component,** starting with `ActivityBar` — it carries
   the empty-icon bug and is the most visible surface. Then `ChangesPanel`,
   `Composer`, `MessageList`, `PlanPanel`.
4. **Adjust CSS.** Rules in `styles.css` that size glyphs via `font-size` need to
   become `svg` sizing or flex alignment. Watch `.activity-bar__item`,
   `.icon-button`, `.changes__action--icon`, `.send-button`,
   `.attachment-chip__remove`.
5. **Typecheck and run the suite.**

### Proposed glyph mapping

Export names below are the intended targets, **to be confirmed against the
installed package** during step 3 — Phosphor's naming is descriptive
(`ArrowClockwise`, not `Refresh`) and a few of these may differ.

| Current | Site | Proposed |
|---|---|---|
| `""` (empty) | `ActivityBar.tsx:9` source control | `GitBranch` |
| 🕘 | `ActivityBar.tsx:10` history | `ClockCounterClockwise` |
| ⚙ | `ActivityBar.tsx:11` settings | `Gear` |
| ▾ | `ChangesPanel.tsx:67` branch chevron | `CaretDown` |
| ⇣ / ⇡ | `ChangesPanel.tsx:72,75` pull/push | `ArrowLineDown` / `ArrowLineUp` |
| ⟳ | `ChangesPanel.tsx:83` refresh | `ArrowClockwise` |
| ✓ | `ChangesPanel.tsx:104` commit & push | `Check` |
| − / + | `ChangesPanel.tsx:124,132` unstage/stage | `Minus` / `Plus` |
| + | `Composer.tsx` attach button | `Plus` |
| 📎 | `Composer.tsx:177`, `MessageList.tsx:175` | `Paperclip` |
| 📋 | `Composer.tsx:220`, `MessageList.tsx:120`, `PlanPanel.tsx:9,28,72` | `ClipboardText` |
| ■ | `Composer.tsx:283` stop | `Stop` (consider `weight="fill"`) |
| ↑ | `Composer.tsx:293` send | `ArrowUp` |
| × | `Composer.tsx` attachment chip remove | `X` |
| ↓ | `MessageList.tsx:83` scroll to bottom | `ArrowDown` |
| 🔐 | `MessageList.tsx:117` permission request | `LockKey` |
| ✓ | `PlanPanel.tsx:75` | `Check` |
| ☑ / ☐ | `PlanPanel.tsx:91` | `CheckSquare` / `Square` |

## Out of scope for this pass

- **`ContextGauge.tsx:28`** — the inline SVG donut is a data visualization driven
  by usage numbers, not an icon. It stays.
- **The two `<select>` pickers** (`Composer.tsx:232` mode ⏵⏵, `Composer.tsx:246`
  permission ⚡/🛡, and shared `OptionPicker.tsx`). **Assumption, pending user
  confirmation:** strip the glyphs and leave these text-only rather than rewrite
  them as custom dropdowns. Converting three native selects into accessible
  custom listboxes is a meaningfully larger change than an icon refresh and
  deserves its own task. Flagged as open question 1 below.
- **Non-UI glyphs**, which are data or parsing tokens and must not change:
  `demoAdapters.ts:96` (✓ in fixture text), `plan.ts:28` + `plan.test.ts:27`
  (⟵ parse token), `provider.ts:34-35` and `history.ts:97` (→ in prose).

## Risks and unknowns

- **Bundle size.** Phosphor is a large package. Per-icon named imports must
  tree-shake correctly under Vite; verify the production build does not balloon.
  If it does, `@phosphor-icons/react/dist/ssr` exposes the same icons with
  lighter module boundaries.
- **Optical weight shift.** Phosphor at `regular` is lighter than the Unicode
  glyphs it replaces. The chrome may read as washed-out against `--text-dim` and
  need `bold`, or a `--text-dim` nudged brighter.
- **Vertical alignment.** SVGs are inline elements and will not sit on the text
  baseline the way the glyphs did. Every button mixing an icon with a label
  (`⇣ Pull`, `✓ Commit & Push`) needs flex alignment, not incidental baseline luck.
- **No test coverage for icons.** Nothing in the suite asserts on rendered glyphs,
  so the tests will not catch a wrong or missing icon — this pass needs visual
  confirmation via `npm run dev`.
- **Naming drift.** The mapping table is proposed, not verified against the
  package's actual exports.

## Open questions

1. **The three `<select>` pickers** — strip glyphs and go text-only now (current
   assumption), or convert them to custom dropdowns as part of this task?
2. **Provider brand marks.** `PROVIDERS` in `core/entities/provider.ts:15-19`
   carries Anthropic / OpenAI / Google, rendered as plain text by `ProviderPicker`.
   Phosphor has no brand logos. Add `simple-icons` (CC0) for these, or leave the
   provider picker as text?
3. Should `git init` run on `G:\mota-editor` so this work is tracked?

## Next steps

- [ ] Confirm open question 1 (select pickers) before touching `Composer.tsx`
- [ ] `npm install @phosphor-icons/react`
- [ ] Add `IconContext.Provider` defaults in `src/ui/App.tsx`
- [ ] Verify proposed export names against the installed package
- [ ] Migrate `ActivityBar.tsx` — fixes the empty-icon bug; add fill/regular active state
- [ ] Migrate `ChangesPanel.tsx`
- [ ] Migrate `Composer.tsx`
- [ ] Migrate `MessageList.tsx`
- [ ] Migrate `PlanPanel.tsx`
- [ ] Update glyph-sizing CSS in `styles.css`
- [ ] `npm run typecheck && npm run test`
- [ ] Visual pass via `npm run dev` — check contrast, alignment, active states
- [ ] Check production bundle size delta
