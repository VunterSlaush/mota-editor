import { describe, expect, it } from "vitest";
import { BRANCH_LIST_LIMIT, filterBranches } from "./branch";

const branch = (name: string, remote = false, current = false) => ({
  name,
  current,
  remote,
});

const BRANCHES = [
  branch("main", false, true),
  branch("feature/login"),
  branch("fix-login"),
  branch("release/2.0", true),
  branch("feature/login-analytics", true),
];

describe("filterBranches", () => {
  it("lists only local branches until something is typed", () => {
    const matches = filterBranches(BRANCHES, "", 10);
    expect(matches.shown.map((b) => b.name)).toEqual([
      "main",
      "feature/login",
      "fix-login",
    ]);
  });

  it("counts the remote branches an empty query leaves out", () => {
    expect(filterBranches(BRANCHES, "", 10).remotesHidden).toBe(2);
  });

  it("puts the current branch first, whatever order git listed it in", () => {
    const reordered = [branch("feature/login"), branch("main", false, true)];
    expect(filterBranches(reordered, "", 10).shown[0].name).toBe("main");
  });

  it("searches remote branches too, once something is typed", () => {
    expect(filterBranches(BRANCHES, "release", 10).shown.map((b) => b.name)).toEqual([
      "release/2.0",
    ]);
  });

  it("hides nothing while searching, so no remote count is reported", () => {
    expect(filterBranches(BRANCHES, "release", 10).remotesHidden).toBe(0);
  });

  it("ranks a local match above a remote one", () => {
    const matches = filterBranches(BRANCHES, "feature/login", 10);
    expect(matches.shown.map((b) => b.name)).toEqual([
      "feature/login",
      "feature/login-analytics",
    ]);
  });

  it("ranks a branch that starts with the query above one that merely contains it", () => {
    const branches = [branch("hotfix/cache"), branch("fix-login")];
    expect(filterBranches(branches, "fix", 10).shown.map((b) => b.name)).toEqual([
      "fix-login",
      "hotfix/cache",
    ]);
  });

  it("ranks a match on the last segment above one buried in the middle", () => {
    expect(filterBranches(BRANCHES, "login", 10).shown.map((b) => b.name)).toEqual([
      "feature/login",
      "fix-login",
      "feature/login-analytics",
    ]);
  });

  it("matches regardless of case", () => {
    expect(filterBranches(BRANCHES, "MAIN", 10).shown.map((b) => b.name)).toEqual([
      "main",
    ]);
  });

  it("keeps git's order among equally good matches", () => {
    const recencyOrdered = [branch("fix-b"), branch("fix-a")];
    expect(filterBranches(recencyOrdered, "fix", 10).shown.map((b) => b.name)).toEqual([
      "fix-b",
      "fix-a",
    ]);
  });

  it("caps the rows it shows but counts every match", () => {
    const many = Array.from({ length: 400 }, (_, i) => branch(`feature/${i}`));
    const matches = filterBranches(many, "feature", 50);
    expect(matches.shown).toHaveLength(50);
    expect(matches.total).toBe(400);
  });

  it("caps the unsearched list too, and counts the branches behind it", () => {
    const many = Array.from({ length: 400 }, (_, i) => branch(`feature/${i}`));
    const matches = filterBranches(many, "", 50);
    expect(matches.shown).toHaveLength(50);
    expect(matches.total).toBe(400);
  });

  it("finds nothing when nothing matches", () => {
    const matches = filterBranches(BRANCHES, "zzz", 10);
    expect(matches.shown).toEqual([]);
    expect(matches.total).toBe(0);
  });

  it("shows fifty rows at most by default", () => {
    expect(BRANCH_LIST_LIMIT).toBe(50);
  });
});
