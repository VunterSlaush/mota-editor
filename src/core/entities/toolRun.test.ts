import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./message";
import {
  assistantMessage,
  errorMessage,
  infoMessage,
  thoughtMessage,
  toolCallMessage,
  toolMessage,
  userMessage,
} from "./message";
import { groupToolRuns, segmentQuietRuns, summarizeRun } from "./toolRun";

const call = (kind: string, title: string, status = "completed") =>
  toolCallMessage(`c-${title}`, kind, title, status);

const withContent = (message: ChatMessage): ChatMessage => ({
  ...message,
  toolCall: message.toolCall && {
    ...message.toolCall,
    content: [{ type: "text", text: "output" }],
  },
});

describe("groupToolRuns", () => {
  it("folds consecutive same-tool rows into one counted row", () => {
    const rows = groupToolRuns([
      call("search", "auth"),
      call("search", "login"),
      call("read", "src/main.ts"),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].count).toBe(2);
    expect(rows[0].detail).toBe("auth\nlogin");
    expect(rows[1].count).toBe(1);
  });

  it("collapses exact duplicate details to one line", () => {
    const rows = groupToolRuns([call("search", "auth"), call("search", "auth")]);
    expect(rows[0].count).toBe(2);
    expect(rows[0].detail).toBe("auth");
  });

  it("never folds a row that brought back content", () => {
    const rows = groupToolRuns([withContent(call("read", "a.ts")), call("read", "b.ts")]);
    expect(rows).toHaveLength(2);
  });

  it("keeps the worst status: failed beats running beats completed", () => {
    const rows = groupToolRuns([
      call("execute", "npm test", "completed"),
      call("execute", "npm lint", "in_progress"),
      call("execute", "npm build", "failed"),
    ]);
    expect(rows[0].status).toBe("failed");
  });
});

describe("segmentQuietRuns", () => {
  it("absorbs thoughts between tool rows into one group", () => {
    const items = segmentQuietRuns(
      groupToolRuns([
        userMessage("go"),
        call("read", "a.ts"),
        thoughtMessage("hmm"),
        call("execute", "npm test"),
        assistantMessage("done"),
      ]),
      false,
    );
    expect(items.map((i) => i.kind)).toEqual(["row", "group", "row"]);
    const group = items[1];
    if (group.kind !== "group") throw new Error("expected group");
    expect(group.rows).toHaveLength(3);
  });

  it("bounds groups on every loud role", () => {
    const items = segmentQuietRuns(
      groupToolRuns([
        call("read", "a.ts"),
        errorMessage("boom"),
        call("read", "b.ts"),
        infoMessage("fyi"),
        call("read", "c.ts"),
      ]),
      false,
    );
    expect(items.map((i) => i.kind)).toEqual(["group", "row", "group", "row", "group"]);
  });

  it("groups even a lone tool row", () => {
    const items = segmentQuietRuns(groupToolRuns([call("read", "a.ts")]), false);
    expect(items[0].kind).toBe("group");
  });

  it("passes a quiet-free transcript through untouched", () => {
    const items = segmentQuietRuns(
      groupToolRuns([userMessage("hi"), assistantMessage("hello")]),
      true,
    );
    expect(items.map((i) => i.kind)).toEqual(["row", "row"]);
  });

  it("marks only a busy transcript's trailing run live", () => {
    const messages = [
      call("read", "a.ts"),
      assistantMessage("checking"),
      call("execute", "npm test"),
    ];
    const items = segmentQuietRuns(groupToolRuns(messages), true);
    expect(items[0].kind === "group" && items[0].live).toBe(false);
    expect(items[2].kind === "group" && items[2].live).toBe(true);

    // The same transcript after the turn ends: everything collapsed.
    const settled = segmentQuietRuns(groupToolRuns(messages), false);
    expect(settled[2].kind === "group" && settled[2].live).toBe(false);
  });

  it("has no live group when the transcript ends in an answer", () => {
    const items = segmentQuietRuns(
      groupToolRuns([call("read", "a.ts"), assistantMessage("done")]),
      true,
    );
    expect(items[0].kind === "group" && items[0].live).toBe(false);
  });

  it("names the group after its first message", () => {
    const first = call("read", "a.ts");
    const items = segmentQuietRuns(groupToolRuns([first, thoughtMessage("x")]), false);
    expect(items[0].kind === "group" && items[0].id).toBe(first.id);
  });
});

describe("summarizeRun", () => {
  const rows = (...messages: ChatMessage[]) => groupToolRuns(messages);

  it("counts by kind in a fixed order, commands first", () => {
    const summary = summarizeRun(
      rows(
        call("read", "a.ts"),
        call("read", "b.ts"),
        call("execute", "npm test"),
        call("edit", "c.ts"),
      ),
    );
    expect(summary.label).toBe("Ran 1 command, read 2 files, edited 1 file");
  });

  it("pluralizes each bucket on its own", () => {
    expect(summarizeRun(rows(call("search", "x"))).label).toBe("Ran 1 search");
    expect(summarizeRun(rows(call("search", "x"), call("search", "y"))).label).toBe(
      "Ran 2 searches",
    );
    expect(summarizeRun(rows(call("fetch", "docs"))).label).toBe("Fetched 1 page");
  });

  it("counts a folded row's whole count", () => {
    const folded = rows(call("read", "a.ts"), call("read", "b.ts"));
    expect(folded[0].count).toBe(2);
    expect(summarizeRun(folded).label).toBe("Read 2 files");
  });

  it("counts a legacy row with no toolCall by its tool name", () => {
    expect(summarizeRun(rows(toolMessage("read", "a.ts"))).label).toBe("Read 1 file");
  });

  it("sweeps unknown kinds into other actions", () => {
    expect(summarizeRun(rows(call("delete", "old.ts"))).label).toBe(
      "Took 1 other action",
    );
  });

  it("absorbs thoughts without advertising them beside real work", () => {
    const summary = summarizeRun(rows(thoughtMessage("hmm"), call("read", "a.ts")));
    expect(summary.label).toBe("Read 1 file");
  });

  it("labels a thoughts-only run as thoughts", () => {
    expect(summarizeRun(rows(thoughtMessage("a"))).label).toBe("1 thought");
    expect(summarizeRun(rows(thoughtMessage("a"), thoughtMessage("b"))).label).toBe(
      "2 thoughts",
    );
  });

  it("appends the failure count and carries the failed status", () => {
    const summary = summarizeRun(
      rows(call("execute", "npm test", "failed"), call("read", "a.ts")),
    );
    expect(summary.label).toBe("Ran 1 command, read 1 file · 1 failed");
    expect(summary.failed).toBe(1);
    expect(summary.status).toBe("failed");
  });
});
