import { describe, expect, it } from "vitest";
import { appBadge, sameBadge } from "./appBadge";
import { approvalMessage, assistantMessage, errorMessage } from "./message";

const idle = () => ({ messages: [assistantMessage("done")], busy: false });
const busy = () => ({ messages: [assistantMessage("…")], busy: true });
const done = () => ({ ...idle(), attention: true });
const failed = () => ({ messages: [errorMessage("boom")], busy: false });
const waiting = () => ({
  messages: [
    approvalMessage("Run npm test", {
      requestId: "r1",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    }),
  ],
  busy: false,
});

describe("appBadge", () => {
  it("says nothing when every tab is idle", () => {
    expect(appBadge([])).toBeNull();
    expect(appBadge([idle(), idle()])).toBeNull();
  });

  it("counts the tabs in the state it reports", () => {
    expect(appBadge([busy(), busy(), idle()])).toEqual({ level: "busy", count: 2 });
  });

  it("reports the worst state present, not the most common", () => {
    // Three working tabs do not outrank one failure: the failure is the
    // thing you would want to know about first.
    expect(appBadge([busy(), busy(), busy(), failed()])).toEqual({
      level: "error",
      count: 1,
    });
  });

  it("ranks error over waiting, waiting over finished, finished over busy", () => {
    expect(appBadge([waiting(), done(), busy()])?.level).toBe("needsInput");
    expect(appBadge([done(), busy()])?.level).toBe("done");
    expect(appBadge([busy(), idle()])?.level).toBe("busy");
    expect(appBadge([failed(), waiting()])?.level).toBe("error");
  });
});

describe("sameBadge", () => {
  it("is true only for badges that would look identical", () => {
    const badge = { level: "busy", count: 2 } as const;
    expect(sameBadge(badge, { level: "busy", count: 2 })).toBe(true);
    expect(sameBadge(badge, { level: "busy", count: 3 })).toBe(false);
    expect(sameBadge(badge, { level: "error", count: 2 })).toBe(false);
    expect(sameBadge(null, null)).toBe(true);
    expect(sameBadge(badge, null)).toBe(false);
  });
});
