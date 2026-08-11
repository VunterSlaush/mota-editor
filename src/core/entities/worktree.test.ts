import { describe, expect, it } from "vitest";
import {
  defaultContainer,
  deriveBranchName,
  deriveWorktreePath,
  effectiveProvisioning,
  folderSuggestions,
  provisionPathProblem,
  removalCheck,
  samePath,
  sanitizeBranchForPath,
  shareRisk,
} from "./worktree";

describe("sanitizeBranchForPath", () => {
  it("turns branch separators into dashes", () => {
    expect(sanitizeBranchForPath("feature/login")).toBe("feature-login");
    expect(sanitizeBranchForPath("fix/ui/tab bar")).toBe("fix-ui-tab-bar");
  });

  it("keeps ordinary branch names as they are", () => {
    expect(sanitizeBranchForPath("main")).toBe("main");
    expect(sanitizeBranchForPath("release-1.2")).toBe("release-1.2");
  });

  it("collapses runs and trims edge punctuation", () => {
    expect(sanitizeBranchForPath("weird//---name")).toBe("weird-name");
    expect(sanitizeBranchForPath("-lead.trail.")).toBe("lead.trail");
  });
});

describe("effectiveProvisioning", () => {
  const appDefault = [{ path: "node_modules", strategy: "clone" as const }];

  it("follows the app default when the project set nothing", () => {
    expect(effectiveProvisioning(undefined, appDefault)).toBe(appDefault);
  });

  it("treats an empty project list as a real answer, not a gap", () => {
    expect(effectiveProvisioning([], appDefault)).toEqual([]);
  });

  it("replaces the default entirely rather than merging", () => {
    const own = [{ path: "dist", strategy: "share" as const }];
    expect(effectiveProvisioning(own, appDefault)).toEqual(own);
  });
});

describe("samePath", () => {
  it("matches across slash style, trailing slash, and case", () => {
    expect(samePath("C:\\repos\\app", "c:/repos/app/")).toBe(true);
    expect(samePath("/home/u/app", "/home/u/app")).toBe(true);
    expect(samePath("/home/u/app", "/home/u/other")).toBe(false);
  });
});

describe("deriveBranchName", () => {
  it("forks base-2 first, then counts up past taken names", () => {
    expect(deriveBranchName("main", [])).toBe("main-2");
    expect(deriveBranchName("main", ["main-2", "main-3"])).toBe("main-4");
  });

  it("compares taken names case-insensitively", () => {
    expect(deriveBranchName("Fix", ["fix-2"])).toBe("Fix-3");
  });
});

describe("deriveWorktreePath", () => {
  it("puts the worktree in a sibling container named after the repo", () => {
    expect(deriveWorktreePath("/repos/app", "feature/login", [])).toBe(
      "/repos/app-worktrees/feature-login",
    );
  });

  it("uses the repo path's own separator style", () => {
    expect(deriveWorktreePath("C:\\repos\\app", "dev", [])).toBe(
      "C:\\repos\\app-worktrees\\dev",
    );
  });

  it("suffixes when the derived path is already a known worktree", () => {
    const taken = ["/repos/app-worktrees/dev", "/repos/app-worktrees/dev-2"];
    expect(deriveWorktreePath("/repos/app", "dev", taken)).toBe(
      "/repos/app-worktrees/dev-3",
    );
  });

  it("compares taken paths loosely, the way git reports them", () => {
    const taken = ["C:/repos/app-worktrees/dev"];
    expect(deriveWorktreePath("C:\\repos\\app", "dev", taken)).toBe(
      "C:\\repos\\app-worktrees\\dev-2",
    );
  });

  it("falls back to a plain name when the branch sanitizes to nothing", () => {
    expect(deriveWorktreePath("/repos/app", "///", [])).toBe(
      "/repos/app-worktrees/worktree",
    );
  });

  it("puts the worktree in the configured container instead", () => {
    expect(deriveWorktreePath("/repos/app", "dev", [], "/volumes/fast/trees")).toBe(
      "/volumes/fast/trees/dev",
    );
  });

  it("still suffixes collisions inside a configured container", () => {
    const taken = ["/volumes/fast/trees/dev"];
    expect(deriveWorktreePath("/repos/app", "dev", taken, "/volumes/fast/trees")).toBe(
      "/volumes/fast/trees/dev-2",
    );
  });

  it("takes the container's own separator, not the repository's", () => {
    expect(deriveWorktreePath("/repos/app", "dev", [], "C:\\trees")).toBe(
      "C:\\trees\\dev",
    );
  });

  it("treats a blank or whitespace container as unset", () => {
    expect(deriveWorktreePath("/repos/app", "dev", [], "   ")).toBe(
      "/repos/app-worktrees/dev",
    );
  });

  it("ignores a trailing separator on the container", () => {
    expect(deriveWorktreePath("/repos/app", "dev", [], "/trees/")).toBe("/trees/dev");
  });
});

describe("defaultContainer", () => {
  it("is the sibling folder the placeholder promises", () => {
    expect(defaultContainer("/repos/app")).toBe("/repos/app-worktrees");
    expect(defaultContainer("C:\\repos\\app")).toBe("C:\\repos\\app-worktrees");
  });
});

describe("provisionPathProblem", () => {
  it("accepts an ordinary repository-relative folder", () => {
    expect(provisionPathProblem("node_modules")).toBeUndefined();
    expect(provisionPathProblem("src-tauri/target")).toBeUndefined();
  });

  it("refuses an absolute path, in either platform's spelling", () => {
    expect(provisionPathProblem("/etc")).toMatch(/relative/);
    expect(provisionPathProblem("C:\\Windows")).toMatch(/relative/);
  });

  it("refuses a path that steps outside the worktree", () => {
    expect(provisionPathProblem("../escape")).toMatch(/outside/);
    expect(provisionPathProblem("a/../../b")).toMatch(/outside/);
  });

  it("refuses git's own folder", () => {
    expect(provisionPathProblem(".git")).toMatch(/Git/);
    expect(provisionPathProblem(".git/config")).toMatch(/Git/);
  });

  it("asks for a folder when the row is still blank", () => {
    expect(provisionPathProblem("")).toMatch(/Needs a folder/);
    expect(provisionPathProblem("  ")).toMatch(/Needs a folder/);
  });
});

describe("removalCheck", () => {
  const linked = { main: false, locked: false };

  it("calls a merged, clean, unlocked worktree free to reclaim", () => {
    const check = removalCheck(0, linked, true);
    expect(check.reclaimable).toBe(true);
    expect(check.needsForce).toBe(false);
    expect(check.blockers).toEqual([]);
  });

  it("does not block an unmerged branch, but does not advertise it either", () => {
    const check = removalCheck(0, linked, false);
    expect(check.reclaimable).toBe(false);
    expect(check.blockers).toEqual([]);
  });

  it("treats any changed file as work that needs force", () => {
    const check = removalCheck(3, linked, true);
    expect(check.needsForce).toBe(true);
    expect(check.reclaimable).toBe(false);
    expect(check.blockers).toEqual(["3 uncommitted or untracked files."]);
  });

  it("counts one file in the singular", () => {
    expect(removalCheck(1, linked, true).blockers).toEqual([
      "1 uncommitted or untracked file.",
    ]);
  });

  it("blocks the main checkout however clean it is", () => {
    const check = removalCheck(0, { main: true, locked: false }, true);
    expect(check.reclaimable).toBe(false);
    expect(check.blockers[0]).toContain("main checkout");
  });

  it("blocks a locked worktree rather than offering to force it", () => {
    const check = removalCheck(0, { main: false, locked: true }, true);
    expect(check.reclaimable).toBe(false);
    expect(check.needsForce).toBe(false);
    expect(check.blockers[0]).toContain("Locked");
  });

  it("lists the worst reason first when there is more than one", () => {
    const check = removalCheck(2, { main: true, locked: true }, false);
    expect(check.blockers).toHaveLength(3);
    expect(check.blockers[0]).toContain("main checkout");
  });
});

describe("shareRisk", () => {
  it("warns about folders an agent reads", () => {
    expect(shareRisk("node_modules")).toMatch(/cannot read/);
    expect(shareRisk("api/vendor")).toMatch(/cannot read/);
  });

  it("stays quiet about pure build output", () => {
    expect(shareRisk("src-tauri/target")).toBeUndefined();
    expect(shareRisk("dist")).toBeUndefined();
  });
});

describe("folderSuggestions", () => {
  const FOLDERS = [
    "docs",
    "node_modules",
    "src",
    "src/ui",
    "src-tauri",
    "src-tauri/target",
  ];

  it("offers the likely-heavy folders first when nothing is typed", () => {
    expect(folderSuggestions(FOLDERS, "", [])[0]).toBe("node_modules");
  });

  it("matches what has been typed, anywhere in the path", () => {
    expect(folderSuggestions(FOLDERS, "target", [])).toEqual(["src-tauri/target"]);
  });

  it("leaves out folders already on the list", () => {
    expect(folderSuggestions(FOLDERS, "", ["node_modules"])).not.toContain(
      "node_modules",
    );
  });

  it("ignores the trailing slash and slash style of a listed folder", () => {
    expect(folderSuggestions(FOLDERS, "", ["src-tauri\\target\\"])).not.toContain(
      "src-tauri/target",
    );
  });

  it("never offers more than the limit", () => {
    expect(folderSuggestions(FOLDERS, "", [], 2)).toHaveLength(2);
  });
});
