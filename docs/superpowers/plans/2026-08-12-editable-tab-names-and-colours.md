# Editable Tab Names and Colour Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every project tab an optional user-written name and an optional grouping colour, both persisted, so tabs belonging to one task read as a group regardless of which repository they point at.

**Architecture:** Two optional fields on the `Project` entity (`label`, `color`), two reducer actions, one use-case file, one popover component. The colour is a named id only — its value lives in per-theme CSS and renders as a low-opacity wash mixed into the tab's existing background, so identity (faded, large) never competes with status (saturated, small). No new entity, no group object, no new dependency.

**Tech Stack:** TypeScript (strict), React 18, vitest, biome, CSS custom properties with `color-mix()` / `oklch()`.

**Spec:** `docs/superpowers/specs/2026-08-12-editable-tab-names-and-colours-design.md`

## Global Constraints

- **npm only.** Never pnpm or yarn.
- **No new dependencies.** Every piece of this is built from what's already installed.
- `src/core/**` must import nothing from `react`, `@tauri-apps/*`, or `src/adapters/**`. Enforced by `npm test` via `scripts/architecture.mjs`.
- All adapter/use-case construction happens in `src/wiring/context.ts` only.
- Comments explain **why**, never **what**. A comment that paraphrases the code is a failure to name things well.
- `npm run typecheck` (`tsc --noEmit`, strict) stays clean; `npm run lint` (biome) stays clean.
- Test names state the behaviour, not the method — e.g. `re-activates the existing tab when the same folder is opened twice`.
- Label cap is **60 characters**, trimmed, empty becomes absent.
- Palette is exactly seven ids: `red`, `amber`, `green`, `teal`, `blue`, `violet`, `grey`.
- Wash percentages: **12%** into `--bg-raised` for an inactive tab, **22%** into `--bg` for active and dragging.
- Run one test file with `npx vitest run <path>`; the whole suite with `npm test`.
- Do not touch `src-tauri/`. This change is frontend-only.
- Commit after every task. Never pass `--no-verify`.

---

### Task 1: The `tabColor` entity

**Files:**
- Create: `src/core/entities/tabColor.ts`
- Test: `src/core/entities/tabColor.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type TabColorId = "red" | "amber" | "green" | "teal" | "blue" | "violet" | "grey"`, `interface TabColorInfo { readonly id: TabColorId; readonly label: string }`, `const TAB_COLORS: readonly TabColorInfo[]`, `function isTabColorId(value: string): value is TabColorId`.

- [ ] **Step 1: Write the failing test**

Create `src/core/entities/tabColor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isTabColorId, TAB_COLORS } from "./tabColor";

describe("tab colours", () => {
  it("recognises every colour in the palette", () => {
    expect(TAB_COLORS).toHaveLength(7);
    for (const color of TAB_COLORS) {
      expect(isTabColorId(color.id)).toBe(true);
    }
  });

  it("does not recognise a colour this build has never had", () => {
    // A workspace file from a newer build, or edited by hand: the tab must
    // end up uncoloured, not pointing at a CSS variable that isn't there.
    expect(isTabColorId("chartreuse")).toBe(false);
    expect(isTabColorId("")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/entities/tabColor.test.ts`
Expected: FAIL — cannot resolve `./tabColor`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/entities/tabColor.ts`:

```ts
/**
 * Entities layer — the palette a tab can be marked with, for grouping the
 * tabs that belong to one task.
 *
 * Ids only. The values live in CSS as `--tab-color-<id>`, the same split
 * `theme.ts` uses, so a colour is drawn in terms of the theme around it
 * instead of being pinned to one palette.
 */
export type TabColorId =
  | "red"
  | "amber"
  | "green"
  | "teal"
  | "blue"
  | "violet"
  | "grey";

export interface TabColorInfo {
  readonly id: TabColorId;
  readonly label: string;
}

/** Every colour, in the order the swatches offer them. */
export const TAB_COLORS: readonly TabColorInfo[] = [
  { id: "red", label: "Red" },
  { id: "amber", label: "Amber" },
  { id: "green", label: "Green" },
  { id: "teal", label: "Teal" },
  { id: "blue", label: "Blue" },
  { id: "violet", label: "Violet" },
  { id: "grey", label: "Grey" },
];

/**
 * Whether a stored string still names a colour. The workspace file is
 * untrusted input: a colour a newer build wrote must leave the tab
 * uncoloured rather than resolve to a CSS variable that does not exist.
 */
export function isTabColorId(value: string): value is TabColorId {
  return TAB_COLORS.some((color) => color.id === value);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/entities/tabColor.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/entities/tabColor.ts src/core/entities/tabColor.test.ts
git commit -m "feat: add the tab colour palette entity"
```

---

### Task 2: `Project.label`, `Project.color`, and the accessors

**Files:**
- Modify: `src/core/entities/project.ts`
- Test: `src/core/entities/project.test.ts`

**Interfaces:**
- Consumes: `TabColorId` from Task 1.
- Produces: `Project.label?: string`, `Project.color?: TabColorId`, `ProjectDefaults.color?: TabColorId`, `const MAX_TAB_LABEL_LENGTH = 60`, `function tabLabel(project: Project): string`, `function normalizedTabLabel(raw: string): string | undefined`. `defaultsFromProject` now carries `color`.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/entities/project.test.ts`. Extend the existing import on line 2 to:

```ts
import {
  defaultsFromProject,
  MAX_TAB_LABEL_LENGTH,
  newProject,
  normalizedTabLabel,
  type ProjectDefaults,
  projectNameFromPath,
  tabLabel,
} from "./project";
```

Then add these tests inside the existing `describe("project entity", ...)` block:

```ts
  it("calls a tab by the user's name when it has one, and its folder's when not", () => {
    const project = newProject("t1", "/work/alpha", defaults);
    expect(tabLabel(project)).toBe("alpha");
    expect(tabLabel({ ...project, label: "auth rewrite" })).toBe("auth rewrite");
  });

  it("stores a name trimmed, and nothing at all when there is nothing left", () => {
    expect(normalizedTabLabel("  auth rewrite  ")).toBe("auth rewrite");
    expect(normalizedTabLabel("   ")).toBeUndefined();
    expect(normalizedTabLabel("")).toBeUndefined();
  });

  it("caps a name at a length the strip could never show anyway", () => {
    const long = "x".repeat(MAX_TAB_LABEL_LENGTH + 20);
    expect(normalizedTabLabel(long)).toHaveLength(MAX_TAB_LABEL_LENGTH);
  });

  it("seeds a new project with the colour it was given, and no key without one", () => {
    expect(newProject("t1", "/a", { ...defaults, color: "teal" }).color).toBe("teal");
    // Absent, not undefined: a key that exists reads as a decision made.
    expect("color" in newProject("t1", "/a", defaults)).toBe(false);
  });

  it("passes a tab's colour to what it seeds, but never its name", () => {
    const source = newProject("t1", "/work/alpha", defaults);
    const seeded = defaultsFromProject({ ...source, color: "violet", label: "auth" });
    expect(seeded.color).toBe("violet");
    expect("label" in seeded).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/entities/project.test.ts`
Expected: FAIL — `tabLabel`, `normalizedTabLabel`, `MAX_TAB_LABEL_LENGTH` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/core/entities/project.ts`, add the import at the top (after the existing imports):

```ts
import type { TabColorId } from "./tabColor";
```

Add two fields to the `Project` interface, immediately after `readonly name: string;`:

```ts
  /**
   * The name the user gave this tab. `name` stays the folder's, because
   * the tooltip still has to say where the tab actually points.
   */
  readonly label?: string;
  /** Grouping colour for the strip; absent means uncoloured. */
  readonly color?: TabColorId;
```

Add to `ProjectDefaults`, after `readonly effort?: string;`:

```ts
  readonly color?: TabColorId;
```

Add these three below `projectNameFromPath`:

```ts
/**
 * Longer than the strip could ever show — it ellipsises well before this.
 * A guard on what reaches the workspace file, not a limit the user feels.
 */
export const MAX_TAB_LABEL_LENGTH = 60;

/** What to call a tab: the user's name for it, else its folder's. */
export function tabLabel(project: Project): string {
  return project.label ?? project.name;
}

/**
 * A name as it should be stored, or nothing when the user left it blank.
 * Absent rather than empty because a tab with no name of its own falls
 * back to its folder's, and `""` would win over it.
 */
export function normalizedTabLabel(raw: string): string | undefined {
  return raw.trim().slice(0, MAX_TAB_LABEL_LENGTH) || undefined;
}
```

In `defaultsFromProject`, add `color` to the returned object:

```ts
export function defaultsFromProject(project: Project): ProjectDefaults {
  return {
    provider: project.provider,
    mode: project.mode,
    permission: project.permission,
    model: project.model,
    effort: project.effort,
    // The colour travels; the name never does. See Worktrees.open.
    color: project.color,
  };
}
```

In `newProject`, add a conditional spread directly after the `provisioningOverride` spread:

```ts
    ...(defaults.color ? { color: defaults.color } : {}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/entities/project.test.ts`
Expected: PASS, all tests including the three pre-existing ones.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/entities/project.ts src/core/entities/project.test.ts
git commit -m "feat: add an optional name and colour to a project"
```

---

### Task 3: Reducer actions

**Files:**
- Modify: `src/core/state/appState.ts`
- Test: `src/core/state/appState.test.ts`

**Interfaces:**
- Consumes: `normalizedTabLabel` and `TabColorId` from Task 2.
- Produces: actions `{ type: "tab/labelChanged"; tabId: string; label: string }` and `{ type: "tab/colorChanged"; tabId: string; color: TabColorId | undefined }`.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/state/appState.test.ts`, inside `describe("appState reducer", ...)`:

```ts
  it("names a tab without disturbing what its folder is called", () => {
    let state = open(initialState, "t1", "/work/alpha");
    state = reduce(state, {
      type: "tab/labelChanged",
      tabId: "t1",
      label: "auth rewrite",
    });
    expect(activeTab(state)?.project.label).toBe("auth rewrite");
    expect(activeTab(state)?.project.name).toBe("alpha");
  });

  it("clearing a tab's name removes it instead of storing a blank", () => {
    let state = open(initialState, "t1", "/work/alpha");
    state = reduce(state, { type: "tab/labelChanged", tabId: "t1", label: "auth" });
    state = reduce(state, { type: "tab/labelChanged", tabId: "t1", label: "   " });
    // A key holding "" would beat the folder name in `tabLabel`.
    expect("label" in (activeTab(state)?.project ?? {})).toBe(false);
  });

  it("colours a tab, and taking the colour away removes the key", () => {
    let state = open(initialState, "t1", "/work/alpha");
    state = reduce(state, { type: "tab/colorChanged", tabId: "t1", color: "teal" });
    expect(activeTab(state)?.project.color).toBe("teal");
    state = reduce(state, {
      type: "tab/colorChanged",
      tabId: "t1",
      color: undefined,
    });
    expect("color" in (activeTab(state)?.project ?? {})).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/state/appState.test.ts`
Expected: FAIL — the action types are not assignable to `Action`.

- [ ] **Step 3: Write minimal implementation**

In `src/core/state/appState.ts`, extend the existing `project` import to bring in the helper:

```ts
import type { Project, ProjectDefaults } from "../entities/project";
import { normalizedTabLabel } from "../entities/project";
```

Add an import for the colour type:

```ts
import type { TabColorId } from "../entities/tabColor";
```

Add two members to the `Action` union, next to `tab/verboseChanged`:

```ts
  | { type: "tab/labelChanged"; tabId: string; label: string }
  | { type: "tab/colorChanged"; tabId: string; color: TabColorId | undefined }
```

Add two cases to `reduce`, next to `case "tab/verboseChanged"`:

```ts
    // Both delete their key when cleared rather than storing a blank, the
    // same tri-state mcpOverrides and provisioningOverride already keep:
    // absent means "the user never named one", and an empty string or an
    // explicit undefined would read as a choice that was made.
    case "tab/labelChanged":
      return mapTab(state, action.tabId, (tab) => {
        const { label: _, ...project } = tab.project;
        const label = normalizedTabLabel(action.label);
        return { ...tab, project: label ? { ...project, label } : project };
      });

    case "tab/colorChanged":
      return mapTab(state, action.tabId, (tab) => {
        const { color: _, ...project } = tab.project;
        return {
          ...tab,
          project: action.color ? { ...project, color: action.color } : project,
        };
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/state/appState.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/state/appState.ts src/core/state/appState.test.ts
git commit -m "feat: reduce a tab's name and colour changes"
```

---

### Task 4: Persistence round-trip

**Files:**
- Modify: `src/core/ports/workspacePort.ts`
- Modify: `src/core/usecases/persistWorkspace.ts:11-27`
- Modify: `src/core/usecases/restoreWorkspace.ts:31-46`
- Test: `src/core/usecases/restoreWorkspace.test.ts`

**Interfaces:**
- Consumes: `isTabColorId` from Task 1; `Project.label` / `Project.color` from Task 2.
- Produces: `PersistedProject.label?: string`, `PersistedProject.color?: string` (a plain string on purpose — see below).

- [ ] **Step 1: Write the failing tests**

Add to `src/core/usecases/restoreWorkspace.test.ts`. Note these tests inline their project literal, matching the file's existing style — there is no shared fixture.

```ts
describe("RestoreWorkspace tab names and colours", () => {
  it("brings a tab's name and colour back, still naming the folder from the path", async () => {
    const state = await restore({
      projects: [
        {
          id: "t1",
          path: "/work/alpha",
          provider: "claude",
          providerSessions: {},
          label: "auth rewrite",
          color: "teal",
        },
      ],
      activeTabId: "t1",
    });

    expect(state.tabs[0].project.label).toBe("auth rewrite");
    expect(state.tabs[0].project.color).toBe("teal");
    // The whole reason `label` is its own field: `name` is recomputed
    // from the path on every restore and would have eaten it.
    expect(state.tabs[0].project.name).toBe("alpha");
  });

  it("leaves a tab uncoloured when the file names a colour this build lost", async () => {
    const state = await restore({
      projects: [
        {
          id: "t1",
          path: "/work/alpha",
          provider: "claude",
          providerSessions: {},
          color: "chartreuse",
        },
      ],
      activeTabId: "t1",
    });

    expect(state.tabs[0].project.color).toBeUndefined();
  });

  it("loads a workspace written before tabs could be named", async () => {
    const state = await restore({
      projects: [
        { id: "t1", path: "/work/alpha", provider: "claude", providerSessions: {} },
      ],
      activeTabId: "t1",
    });

    expect(state.tabs[0].project.label).toBeUndefined();
    expect(state.tabs[0].project.color).toBeUndefined();
    expect(state.tabs[0].project.name).toBe("alpha");
  });

  it("carries a name and colour through a save and back", async () => {
    // The round trip, not the intermediate shape: this fails if either
    // toPersisted or restoreWorkspace forgets a field.
    const store = new Store();
    store.dispatch({
      type: "tab/opened",
      project: {
        id: "t1",
        path: "/work/alpha",
        name: "alpha",
        provider: "claude",
        mode: "agent",
        permission: "manual",
        verbose: true,
        providerSessions: {},
        label: "auth rewrite",
        color: "violet",
      },
    });

    const state = await restore(toPersisted(store.getState()));

    expect(state.tabs[0].project.label).toBe("auth rewrite");
    expect(state.tabs[0].project.color).toBe("violet");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/usecases/restoreWorkspace.test.ts`
Expected: FAIL — `label` and `color` are not properties of `PersistedProject`.

- [ ] **Step 3: Write minimal implementation**

In `src/core/ports/workspacePort.ts`, add to `PersistedProject` after `readonly effort?: string;`:

```ts
  /** The name the user gave this tab, if any. */
  readonly label?: string;
  /**
   * Grouping colour id. A plain string, not `TabColorId`: this comes out
   * of a file, so whether it still names a colour is decided by the guard
   * at restore rather than asserted by the type.
   */
  readonly color?: string;
```

In `src/core/usecases/persistWorkspace.ts`, add to the object built in `toPersisted`, after `effort`:

```ts
      label: t.project.label,
      color: t.project.color,
```

In `src/core/usecases/restoreWorkspace.ts`, add the import:

```ts
import { isTabColorId } from "../entities/tabColor";
```

and add to the project mapping, after `effort: p.effort,`:

```ts
        label: p.label,
        // The file may name a colour this build does not have.
        color: p.color && isTabColorId(p.color) ? p.color : undefined,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/usecases/restoreWorkspace.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/ports/workspacePort.ts src/core/usecases/persistWorkspace.ts src/core/usecases/restoreWorkspace.ts src/core/usecases/restoreWorkspace.test.ts
git commit -m "feat: persist a tab's name and colour"
```

---

### Task 5: A worktree inherits the colour, never the name

**Files:**
- Modify: `src/core/usecases/worktrees.ts:101-106`
- Test: `src/core/usecases/worktrees.test.ts`

**Interfaces:**
- Consumes: `ProjectDefaults.color` from Task 2; the reducer actions from Task 3.
- Produces: no new exports. Behaviour only.

- [ ] **Step 1: Write the failing tests**

Add to `src/core/usecases/worktrees.test.ts`, inside the existing `describe("Worktrees.create", ...)` block (the one containing "falls back to the app defaults when inheriting is turned off" at line 352):

```ts
  it("carries the source tab's colour into the worktree's tab", async () => {
    const { store, git, worktrees } = setup();
    store.dispatch({ type: "tab/colorChanged", tabId: "t1", color: "violet" });
    git.worktreeList = [worktree({ path: "C:/repos/app", main: true })];
    await worktrees.create("t1", "dev", "new");

    expect(store.getState().tabs[1].project.color).toBe("violet");
  });

  it("carries the colour even when inheriting agent settings is turned off", async () => {
    // The toggle governs provider/model/permission — what the AGENT runs.
    // A grouping colour is not one of those, and a worktree forked from a
    // task's tab is that task.
    const { store, git, worktrees } = setup();
    store.dispatch({ type: "tab/colorChanged", tabId: "t1", color: "violet" });
    store.dispatch({
      type: "settings/changed",
      patch: {
        worktrees: { ...defaultSettings.worktrees, inheritFromSourceTab: false },
      },
    });
    git.worktreeList = [worktree({ path: "C:/repos/app", main: true })];
    await worktrees.create("t1", "dev", "new");

    expect(store.getState().tabs[1].project.color).toBe("violet");
  });

  it("never carries the source tab's name", async () => {
    // Two tabs called the same thing is worse than one called nothing.
    const { store, git, worktrees } = setup();
    store.dispatch({
      type: "tab/labelChanged",
      tabId: "t1",
      label: "auth rewrite",
    });
    git.worktreeList = [worktree({ path: "C:/repos/app", main: true })];
    await worktrees.create("t1", "dev", "new");

    expect(store.getState().tabs[1].project.label).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/usecases/worktrees.test.ts`
Expected: the two colour tests FAIL (`color` is `undefined`). The name test passes already — that is fine and expected; it is a regression guard on a decision, not a driver of new code.

- [ ] **Step 3: Write minimal implementation**

In `src/core/usecases/worktrees.ts`, replace the `newProject` call in `open` (lines 101-106) with:

```ts
    const project = newProject(
      this.newId(),
      worktreePath,
      {
        ...defaults,
        provisioningOverride: source?.project.provisioningOverride,
        // Travels regardless of inheritFromSourceTab, for a different
        // reason than provisioning does: that toggle governs what the
        // AGENT runs (provider, model, permission), and a grouping colour
        // is not that. A worktree forked from a task's tab is that task.
        // The label deliberately stays behind — two tabs with one name
        // are worse than one with none.
        color: source?.project.color,
      },
      worktreeOf,
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/usecases/worktrees.test.ts`
Expected: PASS, including the pre-existing inheritance tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/usecases/worktrees.ts src/core/usecases/worktrees.test.ts
git commit -m "feat: a worktree tab inherits its source tab's colour"
```

---

### Task 6: `RenameTab` and `RecolorTab` use cases, wired

**Files:**
- Create: `src/core/usecases/tabIdentity.ts`
- Create: `src/core/usecases/tabIdentity.test.ts`
- Modify: `src/wiring/context.ts`

**Interfaces:**
- Consumes: the reducer actions from Task 3; `TabColorId` from Task 1.
- Produces: `class RenameTab { execute(tabId: string, label: string): Promise<void> }`, `class RecolorTab { execute(tabId: string, color: TabColorId | undefined): Promise<void> }`, and `context.renameTab` / `context.recolorTab`.

- [ ] **Step 1: Write the failing test**

Create `src/core/usecases/tabIdentity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import { defaultSettings, projectDefaults, tabById } from "../state/appState";
import { Store } from "../state/store";
import { RecolorTab, RenameTab } from "./tabIdentity";

class FakeWorkspaceStore implements WorkspaceStore {
  saves = 0;
  saved: PersistedWorkspace | null = null;
  async load() {
    return this.saved;
  }
  async save(workspace: PersistedWorkspace) {
    this.saves += 1;
    this.saved = workspace;
  }
}

const DEFAULTS = projectDefaults(defaultSettings);

function setup() {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", DEFAULTS),
  });
  const workspace = new FakeWorkspaceStore();
  return {
    store,
    workspace,
    renameTab: new RenameTab(store, workspace),
    recolorTab: new RecolorTab(store, workspace),
  };
}

describe("RenameTab", () => {
  it("names a tab and saves the workspace once", async () => {
    const { store, workspace, renameTab } = setup();
    await renameTab.execute("t1", "auth rewrite");

    expect(tabById(store.getState(), "t1")?.project.label).toBe("auth rewrite");
    // Once, not once per character: a save serialises all of it to disk.
    expect(workspace.saves).toBe(1);
  });

  it("an empty name gives the tab back to its folder", async () => {
    const { store, renameTab } = setup();
    await renameTab.execute("t1", "auth rewrite");
    await renameTab.execute("t1", "");

    expect(tabById(store.getState(), "t1")?.project.label).toBeUndefined();
  });
});

describe("RecolorTab", () => {
  it("colours a tab and saves the workspace once", async () => {
    const { store, workspace, recolorTab } = setup();
    await recolorTab.execute("t1", "teal");

    expect(tabById(store.getState(), "t1")?.project.color).toBe("teal");
    expect(workspace.saves).toBe(1);
  });

  it("takes a colour away again", async () => {
    const { store, recolorTab } = setup();
    await recolorTab.execute("t1", "teal");
    await recolorTab.execute("t1", undefined);

    expect(tabById(store.getState(), "t1")?.project.color).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/usecases/tabIdentity.test.ts`
Expected: FAIL — cannot resolve `./tabIdentity`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/usecases/tabIdentity.ts`:

```ts
import type { TabColorId } from "../entities/tabColor";
import type { WorkspaceStore } from "../ports/workspacePort";
import type { Store } from "../state/store";
import { persistWorkspace } from "./persistWorkspace";

/**
 * Use case — give a tab a name of its own. An empty name clears it, and
 * the tab goes back to being called after its folder.
 */
export class RenameTab {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
  ) {}

  async execute(tabId: string, label: string): Promise<void> {
    this.store.dispatch({ type: "tab/labelChanged", tabId, label });
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}

/**
 * Use case — mark a tab with a grouping colour, or `undefined` to take
 * the mark away.
 */
export class RecolorTab {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
  ) {}

  async execute(tabId: string, color: TabColorId | undefined): Promise<void> {
    this.store.dispatch({ type: "tab/colorChanged", tabId, color });
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/core/usecases/tabIdentity.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Wire into the composition root**

In `src/wiring/context.ts`, add the import alongside the other use-case imports:

```ts
import { RecolorTab, RenameTab } from "../core/usecases/tabIdentity";
```

Add to the `AppContext` interface, next to `readonly reorderTabs: ReorderTabs;`:

```ts
  readonly renameTab: RenameTab;
  readonly recolorTab: RecolorTab;
```

Add to the returned context object, next to `selectVerbose: new SelectVerbose(store, workspaceStore),`:

```ts
    renameTab: new RenameTab(store, workspaceStore),
    recolorTab: new RecolorTab(store, workspaceStore),
```

- [ ] **Step 6: Verify the whole suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, including the architecture boundary checks.

- [ ] **Step 7: Commit**

```bash
git add src/core/usecases/tabIdentity.ts src/core/usecases/tabIdentity.test.ts src/wiring/context.ts
git commit -m "feat: add use cases for naming and colouring a tab"
```

---

### Task 7: The palette and the wash, in CSS

**Files:**
- Modify: `src/ui/styles.css` — the `:root` block at line 1, and the tab rules around lines 240-260.

**Interfaces:**
- Consumes: the seven ids from Task 1.
- Produces: `--tab-color-<id>` for all seven; `--tab-wash` set by any `[data-color="<id>"]` element; the `.tab[data-color]` wash rules.

There is no test for this task — CSS is not unit-tested here, matching the repo's stated trade for humble views. Its deliverable is verified by eye in Task 8.

- [ ] **Step 1: Add the seven hues to the default `:root` block**

In `src/ui/styles.css`, inside the `:root` block that starts at line 1, after the existing background variables:

```css
  /* Tab grouping colours. One set for every theme on purpose: the wash
     mixes a hue into the tab's own background, so the theme supplies the
     lightness and only the hue has to be chosen here. A theme that needs
     a different hue can override the one variable. */
  --tab-color-red: oklch(65% 0.19 25);
  --tab-color-amber: oklch(75% 0.15 75);
  --tab-color-green: oklch(72% 0.17 145);
  --tab-color-teal: oklch(72% 0.11 195);
  --tab-color-blue: oklch(65% 0.17 255);
  --tab-color-violet: oklch(65% 0.19 300);
  --tab-color-grey: oklch(65% 0.02 260);
```

- [ ] **Step 2: Add the hue assignment and the wash rules**

In `src/ui/styles.css`, immediately after the `.tab--active` rule (currently line 249-252):

```css
/* One assignment per colour, on any element that carries the attribute —
   so the tab wearing a colour and the swatch offering it both read from
   the same variable and can never drift apart. */
[data-color="red"] { --tab-wash: var(--tab-color-red); }
[data-color="amber"] { --tab-wash: var(--tab-color-amber); }
[data-color="green"] { --tab-wash: var(--tab-color-green); }
[data-color="teal"] { --tab-wash: var(--tab-color-teal); }
[data-color="blue"] { --tab-wash: var(--tab-color-blue); }
[data-color="violet"] { --tab-wash: var(--tab-color-violet); }
[data-color="grey"] { --tab-wash: var(--tab-color-grey); }

/* A tab's grouping colour is a wash, never a block. Saturated-and-small
   is status (the dot); faded-and-large is identity, so neither has to
   shout over the other.

   Mixed INTO the background the tab already had rather than replacing
   it: the active tab is told apart by its background too, and a colour
   must not cost you the sense of where you are. */
.tab[data-color] {
  background: color-mix(in oklab, var(--tab-wash) 12%, var(--bg-raised));
}

.tab--active[data-color] {
  background: color-mix(in oklab, var(--tab-wash) 22%, var(--bg));
}

/* A dragged tab is lifted off the strip, and stays lifted when coloured —
   the attribute selector would otherwise outrank .tab--dragging's plain
   background and drop it back into the row. */
.tab--dragging[data-color] {
  background: color-mix(in oklab, var(--tab-wash) 22%, var(--bg));
}
```

- [ ] **Step 3: Lint and commit**

```bash
npm run lint
git add src/ui/styles.css
git commit -m "feat: add the tab colour palette and wash to the stylesheet"
```

---

### Task 8: The tab bar shows the name, the wash, and the fuller tooltip

**Files:**
- Modify: `src/ui/components/TabBar.tsx`

**Interfaces:**
- Consumes: `tabLabel` from Task 2; the CSS from Task 7.
- Produces: nothing new yet — `Props` grows in Task 9.

No test: `TabBar` is a humble view, the deliberate trade `ARCHITECTURE.md` documents. Verified by eye in Step 4.

- [ ] **Step 1: Rename the status label, so the tab's own name can have the good name**

In `src/ui/components/TabBar.tsx`, line 37, rename the local so it says which label it is:

```ts
        const statusLabel = TAB_STATUS_LABELS[status];
```

- [ ] **Step 2: Compute the name and the tooltip**

Replace lines 38-42 with:

```ts
        // The branch comes from the tab's cached git read, never a live call.
        const at = tab.branch ? `${tab.project.path} (${tab.branch})` : tab.project.path;
        const where = tab.project.worktreeOf
          ? `${at} — worktree of ${tab.project.worktreeOf}`
          : at;
        const name = tabLabel(tab.project);
        // A named tab still has to say where it points: the name took the
        // folder's place in the strip, so the tooltip is where that goes.
        const named = tab.project.label ? `${tab.project.label} — ${where}` : where;
```

- [ ] **Step 3: Use them in the markup**

Add the import at the top of the file:

```ts
import { tabLabel } from "../../core/entities/project";
```

On the tab `<div>`, change the `title` and add the colour attribute:

```tsx
            title={statusLabel ? `${named} — ${statusLabel}` : named}
            data-color={tab.project.color}
```

Replace the name span (line 71):

```tsx
            <span className="tab__name">{name}</span>
```

And the close button's label (line 79):

```tsx
              aria-label={`Close ${name}`}
```

- [ ] **Step 4: Verify by eye, with a temporary stub**

Nothing can set a colour yet — the popover arrives in Task 9. So force one: in `TabBar.tsx`, temporarily replace the two lines

```tsx
            data-color={tab.project.color}
```
```ts
        const name = tabLabel(tab.project);
```

with

```tsx
            data-color={index === 0 ? "teal" : tab.project.color}
```
```ts
        const name = index === 0 ? "auth rewrite" : tabLabel(tab.project);
```

and change the map callback to `(tab, index) =>`.

Run `npm run dev` with at least two projects open and confirm:
- the first tab carries a faint teal wash, visibly stronger when it is the active tab
- the first tab reads `auth rewrite` where the folder name was
- hovering it shows `auth rewrite — <path>` plus the status when there is one
- dragging it keeps both the wash and the lifted shadow
- the second tab is completely unchanged

Then **revert all three edits** and confirm `git diff src/ui/components/TabBar.tsx` shows only the intended changes from Steps 1-3.

- [ ] **Step 5: Typecheck, lint, and commit**

```bash
npm run typecheck && npm run lint
git add src/ui/components/TabBar.tsx
git commit -m "feat: show a tab's name and colour in the strip"
```

---

### Task 9: The right-click popover

**Files:**
- Create: `src/ui/components/TabMenu.tsx`
- Modify: `src/ui/components/TabBar.tsx`
- Modify: `src/ui/App.tsx:182-189`
- Modify: `src/ui/styles.css`

**Interfaces:**
- Consumes: `TAB_COLORS` / `TabColorId` (Task 1), `MAX_TAB_LABEL_LENGTH` (Task 2), `tooltipPlacement` and `HostRect` from `./tooltipPlacement`, `context.renameTab` / `context.recolorTab` (Task 6).
- Produces: `TabMenu` component; `TabBar` `Props` gain `onRename: (tabId: string, label: string) => void` and `onRecolor: (tabId: string, color: TabColorId | undefined) => void`.

**Deviation from the spec, deliberate:** the spec listed a "Reset to folder name" row. It is dropped. The input's placeholder *is* the folder name, so emptying the field and pressing Enter is the reset, and the placeholder shows you what you will get. A row that duplicates that earns nothing.

- [ ] **Step 1: Write the component**

Create `src/ui/components/TabMenu.tsx`:

```tsx
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAX_TAB_LABEL_LENGTH } from "../../core/entities/project";
import { TAB_COLORS, type TabColorId } from "../../core/entities/tabColor";
import { type HostRect, tooltipPlacement } from "./tooltipPlacement";

interface Props {
  /** The tab's box, to place the panel against. */
  anchor: HostRect;
  /** The tab's own name, empty when it has none. */
  label: string;
  color: TabColorId | undefined;
  /** What the tab is called when it has no name of its own. */
  folderName: string;
  onRename: (label: string) => void;
  onRecolor: (color: TabColorId | undefined) => void;
  onClose: () => void;
}

/**
 * UI — a tab's name and grouping colour, on right-click.
 *
 * The half-typed name lives here and is committed once, on the way out.
 * Committing saves the workspace, and a save serialises the whole thing
 * to disk — so a field that dispatched per keystroke would be a file
 * write per character. Escape leaves without committing, which is only a
 * meaningful distinction because the commit is deferred.
 */
export function TabMenu({
  anchor,
  label,
  color,
  folderName,
  onRename,
  onRecolor,
  onClose,
}: Props) {
  const [draft, setDraft] = useState(label);
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const abandoned = useRef(false);

  // The latest commit, reachable from an unmount that must not depend on
  // it: `onRename` is a fresh arrow on every parent render, so an effect
  // that listed it would tear down and re-run — committing — per render.
  const commit = useRef<() => void>(() => {});
  commit.current = () => {
    if (!abandoned.current && draft !== label) onRename(draft);
  };

  // Every way out of this panel commits, so no exit has to remember to.
  // Empty deps deliberately: the cleanup must run on unmount and at no
  // other time.
  useEffect(() => () => commit.current(), []);

  // Placed after it is drawn, because where it goes depends on how big it
  // turned out — the same measure-then-position the tooltip layer does.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const { left, top } = tooltipPlacement(
      anchor,
      { width: element.offsetWidth, height: element.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.visibility = "visible";
  }, [anchor]);

  // Right-click, type, Enter — with no click in between.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  // A click anywhere else is done with the panel, and takes the name with
  // it: leaving the field commits, exactly as blurring it would.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [onClose]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Escape") {
      event.preventDefault();
      abandoned.current = true;
      onClose();
    }
  };

  return (
    <div
      className="tab-menu"
      ref={panel}
      role="dialog"
      aria-label="Tab name and colour"
      onKeyDown={onKeyDown}
    >
      <input
        ref={field}
        className="tab-menu__name"
        value={draft}
        placeholder={folderName}
        maxLength={MAX_TAB_LABEL_LENGTH}
        aria-label="Tab name"
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="tab-menu__colors" role="group" aria-label="Tab colour">
        <button
          type="button"
          className={`tab-menu__color tab-menu__color--none ${
            color === undefined ? "tab-menu__color--on" : ""
          }`}
          aria-label="No colour"
          aria-pressed={color === undefined}
          onClick={() => onRecolor(undefined)}
        />
        {TAB_COLORS.map((swatch) => (
          <button
            key={swatch.id}
            type="button"
            data-color={swatch.id}
            className={`tab-menu__color ${
              color === swatch.id ? "tab-menu__color--on" : ""
            }`}
            aria-label={swatch.label}
            aria-pressed={color === swatch.id}
            onClick={() => onRecolor(swatch.id)}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Open it from the tab bar**

In `src/ui/components/TabBar.tsx`, add the imports:

```ts
import type { TabColorId } from "../../core/entities/tabColor";
import { TabMenu } from "./TabMenu";
```

Add to `Props`:

```ts
  onRename: (tabId: string, label: string) => void;
  onRecolor: (tabId: string, color: TabColorId | undefined) => void;
```

Add them to the destructured parameters, then above the `return`:

```tsx
  const [menu, setMenu] = useState<{ tabId: string; anchor: DOMRect } | null>(null);
  // Undefined once the tab is gone, so closing a tab with its menu open
  // takes the menu with it.
  const menuTab = menu ? tabs.find((t) => t.project.id === menu.tabId) : undefined;
```

On the tab `<div>`, add:

```tsx
            // preventDefault, or the webview draws its own menu on top.
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ tabId: id, anchor: e.currentTarget.getBoundingClientRect() });
            }}
```

After the `+` button, before `</header>`:

```tsx
      {menuTab && menu && (
        <TabMenu
          anchor={menu.anchor}
          label={menuTab.project.label ?? ""}
          color={menuTab.project.color}
          folderName={menuTab.project.name}
          onRename={(label) => onRename(menuTab.project.id, label)}
          onRecolor={(color) => onRecolor(menuTab.project.id, color)}
          onClose={() => setMenu(null)}
        />
      )}
```

- [ ] **Step 3: Wire the use cases in**

In `src/ui/App.tsx`, add to the `<TabBar ... />` props:

```tsx
        onRename={(tabId, label) => void context.renameTab.execute(tabId, label)}
        onRecolor={(tabId, color) => void context.recolorTab.execute(tabId, color)}
```

- [ ] **Step 4: Style it**

In `src/ui/styles.css`, after the `.tab-bar__add:hover` rule:

```css
/* ---- Tab menu ---- */
/* Fixed and hidden until measured: where it goes depends on how big it
   turned out, so it is drawn once before it is placed. */
.tab-menu {
  position: fixed;
  visibility: hidden;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgb(0 0 0 / 0.35);
}

.tab-menu__name {
  width: 200px;
  padding: 5px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
}

.tab-menu__colors {
  display: flex;
  gap: 6px;
}

.tab-menu__color {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 50%;
  cursor: pointer;
  background: var(--tab-wash);
}

/* The one swatch with no colour of its own: an empty ring, so "none"
   reads as a choice rather than a missing swatch. */
.tab-menu__color--none {
  background: transparent;
}

.tab-menu__color--on {
  outline: 2px solid var(--text);
  outline-offset: 1px;
}
```

- [ ] **Step 5: Verify by hand**

Run: `npm run tauri dev`

Confirm each of these:
- Right-click a tab: the panel opens against it, with the field focused.
- Right-click a tab near the window's right edge: the panel stays inside the window.
- Type a name and press Enter: the strip updates, the panel closes.
- Type a name and click elsewhere: the same — the name is kept.
- Type a name and press Escape: the panel closes and the name is **not** kept.
- Click a swatch: the tab washes immediately and the panel stays open.
- Click the "none" swatch: the wash goes.
- Right-click a **background** tab: the panel opens and the tab does **not** become active.
- Empty the field and press Enter: the folder name comes back.
- Restart the app: names and colours are still there.
- Drag a tab: it still reorders, and right-click still does not start a drag.

- [ ] **Step 6: Full suite, typecheck, lint, commit**

```bash
npm test && npm run typecheck && npm run lint
git add src/ui/components/TabMenu.tsx src/ui/components/TabBar.tsx src/ui/App.tsx src/ui/styles.css
git commit -m "feat: name and colour a tab from a right-click menu"
```

---

### Task 10: The turn-finished notification uses the tab's name

**Files:**
- Modify: `src/core/usecases/sendPrompt.ts:596`
- Test: `src/core/usecases/sendPrompt.test.ts`

**Interfaces:**
- Consumes: `tabLabel` from Task 2.
- Produces: no new exports.

A desktop notification is exactly where "which of my tasks finished" matters, which is the same question the colour answers — so it says the tab's name, not the folder's.

- [ ] **Step 1: Write the failing test**

Add this directly after the existing test `flags a background tab and notifies when its turn completes` (line 1010-1030), which it is modelled on:

```ts
  it("names the tab the way the user did when telling them a turn finished", async () => {
    const { store, notifications, useCase } = setup([
      { kind: "completed", isError: false },
    ]);
    store.dispatch({
      type: "tab/labelChanged",
      tabId: "t1",
      label: "auth rewrite",
    });
    store.dispatch({
      type: "tab/opened",
      project: newProject("t2", "/work/beta", DEFAULTS),
    });
    // t2 is now active; run the turn in t1 (background).

    await useCase.execute("t1", "long refactor");

    expect(notifications.calls).toEqual([
      { projectName: "auth rewrite", providerName: "Claude", tabActive: false },
    ]);
  });
```

The script passed to `setup` drives the turn to completion inside `execute`, so there is nothing to await beyond it — no settle helper needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/core/usecases/sendPrompt.test.ts`
Expected: FAIL — `projectName` is `"alpha"`, the folder's name.

- [ ] **Step 3: Write minimal implementation**

In `src/core/usecases/sendPrompt.ts`, add `tabLabel` to the existing `project` entity import, then change line 596:

```ts
      .turnCompleted(
        // What the user calls the tab, which is the whole point of a
        // notification: which of my tasks just finished?
        tabLabel(tab.project),
        providerById(tab.project.provider).displayName,
        tabActive,
      )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/core/usecases/sendPrompt.test.ts`
Expected: PASS, including the pre-existing notification test (a tab with no label still reports `"alpha"`).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/core/usecases/sendPrompt.ts src/core/usecases/sendPrompt.test.ts
git commit -m "feat: name the tab the user's way in the finished notification"
```

---

### Task 11: The settings screens use the tab's name

**Files:**
- Modify: `src/ui/components/SettingsUsage.tsx:238`
- Modify: `src/ui/components/SettingsTools.tsx:221`
- Modify: `src/ui/components/SettingsWorktrees.tsx:133`

**Interfaces:**
- Consumes: `tabLabel` from Task 2.
- Produces: nothing.

Three one-line changes. Each of these names a tab in a list or a heading, so each shows what the user calls it. `ChatPanel.tsx:571` is **deliberately left alone** — "Ask Claude about {name}" names the codebase the agent can see, and a task name there would misdescribe its scope.

- [ ] **Step 1: Change all three call sites**

In each file, add the import:

```ts
import { tabLabel } from "../../core/entities/project";
```

`SettingsUsage.tsx` line 238:

```tsx
              <span className="usage-row__name">{tabLabel(tab.project)}</span>
```

`SettingsTools.tsx` line 221:

```tsx
        In {tabLabel(tab.project)}: <strong>{effective ? "on" : "off"}</strong>
```

`SettingsWorktrees.tsx` line 133:

```tsx
          <h3 className="settings-section__subtitle">In {tabLabel(activeTab.project)}</h3>
```

- [ ] **Step 2: Confirm the composer was not changed**

Run: `grep -n "project.name" src/ui/components/ChatPanel.tsx`
Expected: line 571 still reads `tab.project.name`. That is the one site that keeps the folder's name.

- [ ] **Step 3: Verify by eye**

Run: `npm run tauri dev`

Name a tab, then open Settings and confirm the Usage row, the Tools scope line, and the Worktrees heading all say the new name — and that the composer placeholder still says the folder.

- [ ] **Step 4: Full suite, typecheck, lint, commit**

```bash
npm test && npm run typecheck && npm run lint
git add src/ui/components/SettingsUsage.tsx src/ui/components/SettingsTools.tsx src/ui/components/SettingsWorktrees.tsx
git commit -m "feat: name tabs the user's way in the settings screens"
```

---

## Final verification

- [ ] `npm test` — the whole suite, including `scripts/architecture.mjs` boundary rules
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run tauri dev` and walk the Task 9 Step 5 checklist once more, in a light theme (`Light+`) and a dark one (`Mota Dark`), confirming the wash is legible in both and the status dot still reads clearly on a red-coloured tab
- [ ] **The density payoff.** Open five or six projects, colour three of them, then narrow the window until the strip drops to `icons` density and every inactive tab loses its name. Confirm the coloured tabs are still tellable apart — this is the case the feature exists for, and it is the one no test covers.
- [ ] **The cost check the spec committed to.** Record RSS with ten tabs open, uncoloured, then colour all ten and record it again — the spec predicts a difference too small to see. Then run a React profiler pass over one streaming turn and compare the tab strip's commit duration with and without colours set. Write both numbers into the spec's "Resource cost" section, replacing the estimates.

Rust is untouched, so `cargo test` / `cargo clippy` are not needed for this change.

## Deliberate gaps

- **`TabMenu` and the CSS have no automated tests**, the same trade `ARCHITECTURE.md` documents for humble views. The consequence worth knowing: the commit-on-blur invariant — one disk write per rename, not per keystroke — has no automated guard. The reviewable evidence is that the `<input>`'s `onChange` only calls `setDraft`, and that the committing effect has empty deps.
- **The strip re-renders per streamed token** (`chat/assistantDelta` → `useAppState` → `App` → `TabBar`). Pre-existing, orders of magnitude larger than anything here, and deliberately not addressed.
- **Red, amber and green appear in both the palette and the status dot.** Accepted: the wash is desaturated and the dot is saturated with a glow, so their visual weights differ. Confirmed by eye in Final verification.
