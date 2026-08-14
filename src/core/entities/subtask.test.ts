import { describe, expect, it } from "vitest";
import {
  boundaryPathProblem,
  describeScope,
  normalizedBoundaries,
  restoredSubtaskScope,
  sameScope,
  subtaskScopeProblem,
} from "./subtask";

describe("boundaryPathProblem", () => {
  it("accepts an ordinary repository-relative folder", () => {
    expect(boundaryPathProblem("apps/frontend")).toBeUndefined();
    expect(boundaryPathProblem("src")).toBeUndefined();
  });

  it("refuses an empty path", () => {
    expect(boundaryPathProblem("  ")).toBeDefined();
  });

  it("refuses absolute paths in both styles", () => {
    expect(boundaryPathProblem("/etc")).toBeDefined();
    expect(boundaryPathProblem("C:\\repos\\app")).toBeDefined();
    expect(boundaryPathProblem("\\share")).toBeDefined();
  });

  it("refuses stepping outside with '..'", () => {
    expect(boundaryPathProblem("../sibling")).toBeDefined();
    expect(boundaryPathProblem("src/../..")).toBeDefined();
  });

  it("refuses git's own folder", () => {
    expect(boundaryPathProblem(".git")).toBeDefined();
    expect(boundaryPathProblem(".git/hooks")).toBeDefined();
  });
});

describe("normalizedBoundaries", () => {
  it("normalises separators and trims trailing slashes", () => {
    expect(normalizedBoundaries(["apps\\frontend\\", "libs/ui/"])).toEqual([
      "apps/frontend",
      "libs/ui",
    ]);
  });

  it("drops duplicates that name the same folder", () => {
    expect(normalizedBoundaries(["apps/web", "apps\\web", "APPS/WEB/"])).toEqual([
      "apps/web",
    ]);
  });

  it("drops blank entries", () => {
    expect(normalizedBoundaries(["", "  ", "src"])).toEqual(["src"]);
  });
});

describe("subtaskScopeProblem", () => {
  it("accepts a read-only scope with no boundaries", () => {
    expect(subtaskScopeProblem({ access: "read-only" })).toBeUndefined();
  });

  it("accepts a boundary scope with at least one valid folder", () => {
    expect(
      subtaskScopeProblem({ access: "boundary", boundaries: ["apps/frontend"] }),
    ).toBeUndefined();
  });

  it("refuses a boundary scope with no folders", () => {
    expect(subtaskScopeProblem({ access: "boundary" })).toBeDefined();
    expect(subtaskScopeProblem({ access: "boundary", boundaries: [] })).toBeDefined();
  });

  it("surfaces the first bad folder's problem", () => {
    const problem = subtaskScopeProblem({
      access: "boundary",
      boundaries: ["apps/frontend", "../out"],
    });
    expect(problem).toContain("..");
  });
});

describe("sameScope", () => {
  it("treats two absent scopes as the same", () => {
    expect(sameScope(undefined, undefined)).toBe(true);
  });

  it("tells absent from present", () => {
    expect(sameScope(undefined, { access: "read-only" })).toBe(false);
  });

  it("compares boundaries as folders, not strings", () => {
    expect(
      sameScope(
        { access: "boundary", boundaries: ["apps\\web\\"] },
        { access: "boundary", boundaries: ["apps/web"] },
      ),
    ).toBe(true);
  });

  it("orders of boundary folders do not matter", () => {
    expect(
      sameScope(
        { access: "boundary", boundaries: ["a", "b"] },
        { access: "boundary", boundaries: ["b", "a"] },
      ),
    ).toBe(true);
  });

  it("different access levels differ", () => {
    expect(
      sameScope({ access: "read-only" }, { access: "boundary", boundaries: ["a"] }),
    ).toBe(false);
  });
});

describe("describeScope", () => {
  it("names read-only plainly", () => {
    expect(describeScope({ access: "read-only" })).toBe("read-only");
  });

  it("lists the writable folders for a boundary", () => {
    expect(
      describeScope({ access: "boundary", boundaries: ["apps/frontend", "libs/ui"] }),
    ).toBe("writes limited to apps/frontend, libs/ui");
  });
});

describe("restoredSubtaskScope", () => {
  it("leaves an absent scope absent — an ordinary tab", () => {
    expect(restoredSubtaskScope(undefined)).toBeUndefined();
    expect(restoredSubtaskScope(null)).toBeUndefined();
  });

  it("restores a read-only scope", () => {
    expect(restoredSubtaskScope({ access: "read-only" })).toEqual({
      access: "read-only",
    });
  });

  it("restores a boundary scope with normalised folders", () => {
    expect(
      restoredSubtaskScope({ access: "boundary", boundaries: ["apps\\web\\"] }),
    ).toEqual({ access: "boundary", boundaries: ["apps/web"] });
  });

  it("degrades an unknown access level to read-only, never to unrestricted", () => {
    expect(restoredSubtaskScope({ access: "everything" })).toEqual({
      access: "read-only",
    });
    expect(restoredSubtaskScope("boundary")).toEqual({ access: "read-only" });
  });

  it("degrades a boundary scope whose folders are all invalid", () => {
    expect(
      restoredSubtaskScope({ access: "boundary", boundaries: ["../out", ""] }),
    ).toEqual({ access: "read-only" });
    expect(restoredSubtaskScope({ access: "boundary" })).toEqual({ access: "read-only" });
  });

  it("keeps the valid folders and drops the invalid ones", () => {
    expect(
      restoredSubtaskScope({ access: "boundary", boundaries: ["apps/web", 7, "../out"] }),
    ).toEqual({ access: "boundary", boundaries: ["apps/web"] });
  });
});
