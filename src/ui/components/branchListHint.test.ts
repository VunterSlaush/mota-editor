import { describe, expect, it } from "vitest";
import { branchListHint } from "./branchListHint";

const matches = (shown: number, total: number, remotesHidden: number) => ({
  shown: Array.from({ length: shown }, (_, i) => i),
  total,
  remotesHidden,
});

describe("branchListHint", () => {
  it("says nothing when the list is showing everything", () => {
    expect(branchListHint(matches(3, 3, 0))).toBeNull();
  });

  it("reports the branches left out past the cap", () => {
    expect(branchListHint(matches(50, 214, 0))).toBe("Showing 50 of 214 branches");
  });

  it("offers the remote branches an empty query hides", () => {
    expect(branchListHint(matches(4, 4, 908))).toBe("Type to search 908 remote branches");
  });

  it("counts a lone remote branch in the singular", () => {
    expect(branchListHint(matches(4, 4, 1))).toBe("Type to search 1 remote branch");
  });

  it("reports both when the list is capped and hiding remotes", () => {
    expect(branchListHint(matches(50, 214, 908))).toBe(
      "Showing 50 of 214 branches · Type to search 908 remote branches",
    );
  });
});
