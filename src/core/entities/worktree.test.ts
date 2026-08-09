import { describe, expect, it } from "vitest";
import { deriveWorktreePath, samePath, sanitizeBranchForPath } from "./worktree";

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

describe("samePath", () => {
  it("matches across slash style, trailing slash, and case", () => {
    expect(samePath("C:\\repos\\app", "c:/repos/app/")).toBe(true);
    expect(samePath("/home/u/app", "/home/u/app")).toBe(true);
    expect(samePath("/home/u/app", "/home/u/other")).toBe(false);
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
});
