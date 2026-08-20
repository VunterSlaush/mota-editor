import { describe, expect, it } from "vitest";
import { filterSessions, matchedKeyword, scopeCounts } from "./sessionFilter";

const OWN = { title: "Fix the parser" };
const POLISH = {
  title: "Tidy the sidebar",
  from: { label: "feature/polish", elsewhere: true },
};
const DOCS = { title: "Write the ADR", from: { label: "docs", elsewhere: true } };
const ALL = [OWN, POLISH, DOCS];
/** A worktree's own session, seen from that worktree's tab: it names its
 *  checkout (the badge does) but it is still "this folder". */
const HERE = { title: "Tidy the sidebar", from: { label: "feature/polish" } };

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

  it("counts a worktree's own sessions as this folder's, not elsewhere's", () => {
    expect(filterSessions([OWN, HERE], "", "own")).toEqual([OWN, HERE]);
    expect(filterSessions([OWN, HERE], "", "worktrees")).toEqual([]);
  });

  it("applies the scope and the text together", () => {
    expect(filterSessions(ALL, "the", "worktrees")).toEqual([POLISH, DOCS]);
    expect(filterSessions(ALL, "sidebar", "own")).toEqual([]);
  });

  it("ignores surrounding whitespace, which a paste always brings", () => {
    expect(filterSessions(ALL, "  parser  ", "all")).toEqual([OWN]);
  });
});

describe("filterSessions, by what a session was about", () => {
  const TOKENS = { title: "Tuesday's chat", keywords: ["reducer", "worktree"] };

  it("finds a session by a theme its title never mentions", () => {
    expect(filterSessions([OWN, TOKENS], "reducer", "all")).toEqual([TOKENS]);
  });

  it("matches a partly typed theme, so results narrow as you type", () => {
    expect(filterSessions([OWN, TOKENS], "worktr", "all")).toEqual([TOKENS]);
  });

  it("keeps the title winning where both could match", () => {
    expect(filterSessions([OWN, TOKENS], "chat", "all")).toEqual([TOKENS]);
  });

  it("costs nothing for a session that has not been indexed", () => {
    expect(filterSessions([OWN], "reducer", "all")).toEqual([]);
  });
});

describe("matchedKeyword", () => {
  it("names the theme that matched, for a row whose title did not", () => {
    expect(matchedKeyword({ title: "Tuesday", keywords: ["reducer"] }, "red")).toBe(
      "reducer",
    );
  });

  it("says nothing when the title already explains the match", () => {
    expect(matchedKeyword({ title: "reducer work", keywords: ["reducer"] }, "red")).toBe(
      undefined,
    );
  });

  it("says nothing when there is no query to have matched", () => {
    expect(matchedKeyword({ title: "Tuesday", keywords: ["reducer"] }, "  ")).toBe(
      undefined,
    );
  });

  it("says nothing when the worktree badge is what matched", () => {
    expect(matchedKeyword(POLISH, "polish")).toBe(undefined);
  });
});

describe("scopeCounts", () => {
  it("counts each side, so the toggles can say how much they hide", () => {
    expect(scopeCounts(ALL)).toEqual({ all: 3, own: 1, worktrees: 2 });
  });

  it("leaves the toggles nothing to offer on a worktree's own tab", () => {
    expect(scopeCounts([HERE, HERE])).toEqual({ all: 2, own: 2, worktrees: 0 });
  });

  it("counts an empty list without inventing anything", () => {
    expect(scopeCounts([])).toEqual({ all: 0, own: 0, worktrees: 0 });
  });
});
