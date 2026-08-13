import { describe, expect, it } from "vitest";
import { filterSessions, scopeCounts } from "./sessionFilter";

const OWN = { title: "Fix the parser" };
const POLISH = { title: "Tidy the sidebar", from: { label: "feature/polish" } };
const DOCS = { title: "Write the ADR", from: { label: "docs" } };
const ALL = [OWN, POLISH, DOCS];

describe("filterSessions", () => {
  it("keeps everything when nothing is typed or toggled", () => {
    expect(filterSessions(ALL, "", "all")).toEqual(ALL);
  });

  it("matches a session by its title, ignoring case", () => {
    expect(filterSessions(ALL, "PARSER", "all")).toEqual([OWN]);
  });

  it("matches a session by the worktree it belongs to", () => {
    expect(filterSessions(ALL, "polish", "all")).toEqual([POLISH]);
  });

  it("narrows to this checkout's own sessions", () => {
    expect(filterSessions(ALL, "", "own")).toEqual([OWN]);
  });

  it("narrows to the worktrees' sessions", () => {
    expect(filterSessions(ALL, "", "worktrees")).toEqual([POLISH, DOCS]);
  });

  it("applies the scope and the text together", () => {
    expect(filterSessions(ALL, "the", "worktrees")).toEqual([POLISH, DOCS]);
    expect(filterSessions(ALL, "sidebar", "own")).toEqual([]);
  });

  it("ignores surrounding whitespace, which a paste always brings", () => {
    expect(filterSessions(ALL, "  parser  ", "all")).toEqual([OWN]);
  });
});

describe("scopeCounts", () => {
  it("counts each side, so the toggles can say how much they hide", () => {
    expect(scopeCounts(ALL)).toEqual({ all: 3, own: 1, worktrees: 2 });
  });

  it("counts an empty list without inventing anything", () => {
    expect(scopeCounts([])).toEqual({ all: 0, own: 0, worktrees: 0 });
  });
});
