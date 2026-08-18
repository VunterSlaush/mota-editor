import { describe, expect, it } from "vitest";
import { questionMessage } from "../entities/message";
import { newProject } from "../entities/project";
import type { GitWorktree } from "../ports/gitPort";
import type { TabState } from "../state/appState";
import { defaultSettings, projectDefaults } from "../state/appState";
import { filterWorktreeRows, worktreeOverview } from "./worktreeOverview";

const DEFAULTS = projectDefaults(defaultSettings);

function worktree(partial: Partial<GitWorktree> & { path: string }): GitWorktree {
  return {
    branch: "feature/polish",
    head: "abc1234",
    main: false,
    bare: false,
    locked: false,
    prunable: false,
    ...partial,
  };
}

function tab(path: string, partial: Partial<TabState> = {}): TabState {
  return {
    project: newProject(`id:${path}`, path, DEFAULTS),
    messages: [],
    busy: false,
    queued: [],
    agentCommands: [],
    plan: [],
    shells: [],
    ...partial,
  };
}

const PENDING_QUESTION = questionMessage("Which one?", "r1", []);

describe("worktreeOverview", () => {
  it("keeps git's order, main checkout first", () => {
    const rows = worktreeOverview(
      [
        worktree({ path: "/repo", branch: "main", main: true }),
        worktree({ path: "/repo-worktrees/polish" }),
      ],
      [],
      "/repo",
    );

    expect(rows.map((r) => r.path)).toEqual(["/repo", "/repo-worktrees/polish"]);
    expect(rows[0].main).toBe(true);
  });

  it("leaves out a bare checkout, which is nothing to open", () => {
    const rows = worktreeOverview(
      [
        worktree({ path: "/repo.git", main: true, bare: true }),
        worktree({ path: "/repo-worktrees/polish" }),
      ],
      [],
      "/repo-worktrees/polish",
    );

    expect(rows.map((r) => r.path)).toEqual(["/repo-worktrees/polish"]);
  });

  it("matches a worktree to its tab across path styles", () => {
    const rows = worktreeOverview(
      [worktree({ path: "C:/repos/mota-worktrees/polish" })],
      [tab("C:\\repos\\mota-worktrees\\Polish")],
      "C:/repos/mota",
    );

    expect(rows[0].openTabId).toBe("id:C:\\repos\\mota-worktrees\\Polish");
  });

  it("reports a worktree nobody has open as closed and idle", () => {
    const rows = worktreeOverview(
      [worktree({ path: "/repo-worktrees/polish" })],
      [tab("/repo")],
      "/repo",
    );

    expect(rows[0].openTabId).toBeNull();
    expect(rows[0].status).toBe("idle");
  });

  it("marks the checkout the panel is shown from", () => {
    const rows = worktreeOverview(
      [
        worktree({ path: "/repo", branch: "main", main: true }),
        worktree({ path: "/repo-worktrees/polish" }),
      ],
      [tab("/repo")],
      "/repo",
    );

    expect(rows.map((r) => r.current)).toEqual([true, false]);
  });

  it("takes an open tab's status from the tab, like the tab bar's dot", () => {
    const rows = worktreeOverview(
      [worktree({ path: "/repo-worktrees/polish" })],
      [tab("/repo-worktrees/polish", { busy: true })],
      "/repo",
    );

    expect(rows[0].status).toBe("busy");
  });

  it("says a worktree's agent is waiting on someone", () => {
    const rows = worktreeOverview(
      [worktree({ path: "/repo-worktrees/polish" })],
      [tab("/repo-worktrees/polish", { busy: true, messages: [PENDING_QUESTION] })],
      "/repo",
    );

    expect(rows[0].status).toBe("needsInput");
  });

  it("carries the branch, head and prunable flag the rows are drawn from", () => {
    const rows = worktreeOverview(
      [worktree({ path: "/gone", branch: "", head: "def5678", prunable: true })],
      [],
      "/repo",
    );

    expect(rows[0]).toMatchObject({ branch: "", head: "def5678", prunable: true });
  });
});

describe("filterWorktreeRows", () => {
  const rows = worktreeOverview(
    [
      {
        path: "G:/repo",
        branch: "main",
        head: "aaa1111",
        main: true,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: "G:/wks/art-8106",
        branch: "feat/pricing-search",
        head: "bbb2222",
        main: false,
        bare: false,
        locked: false,
        prunable: false,
      },
      {
        path: "G:/wks/art-7652",
        branch: "feat/editor-toolbar",
        head: "ccc3333",
        main: false,
        bare: false,
        locked: false,
        prunable: false,
      },
    ],
    [],
    "G:/repo",
  );
  const paths = (query: string) => filterWorktreeRows(rows, query).map((r) => r.path);

  it("returns every row when nothing is typed", () => {
    expect(filterWorktreeRows(rows, "")).toHaveLength(3);
    expect(filterWorktreeRows(rows, "   ")).toHaveLength(3);
  });

  it("matches the branch or the folder, since either is how one is known", () => {
    expect(paths("toolbar")).toEqual(["G:/wks/art-7652"]);
    expect(paths("art-8106")).toEqual(["G:/wks/art-8106"]);
    expect(paths("aaa1111")).toEqual(["G:/repo"]);
  });

  it("ignores case and the separator git and Windows disagree on", () => {
    expect(paths("PRICING")).toEqual(["G:/wks/art-8106"]);
    expect(paths("G:\\wks\\art-7652")).toEqual(["G:/wks/art-7652"]);
  });

  it("narrows with each word rather than widening", () => {
    expect(paths("feat wks")).toHaveLength(2);
    expect(paths("feat pricing")).toEqual(["G:/wks/art-8106"]);
    expect(paths("feat nothing")).toEqual([]);
  });
});
