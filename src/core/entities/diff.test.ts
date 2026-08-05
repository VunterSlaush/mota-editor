import { describe, expect, it } from "vitest";
import { countChanges, parseUnifiedDiff, toSideBySide } from "./diff";

const MIXED = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,5 +10,6 @@ export function App() {",
  "   const before = 1;",
  "-  const gone = 2;",
  "-  const also = 3;",
  "+  const fresh = 2;",
  "   const after = 4;",
  "+  const extra = 5;",
].join("\n");

describe("parseUnifiedDiff", () => {
  it("drops the preamble and keeps the hunk header", () => {
    const hunks = parseUnifiedDiff(MIXED);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].header).toBe("@@ -10,5 +10,6 @@ export function App() {");
  });

  it("numbers old and new lines independently", () => {
    const lines = parseUnifiedDiff(MIXED)[0].lines;
    expect(lines.map((l) => l.kind)).toEqual([
      "context",
      "remove",
      "remove",
      "add",
      "context",
      "add",
    ]);
    expect(lines[0]).toMatchObject({ oldNo: 10, newNo: 10, text: "  const before = 1;" });
    expect(lines[1]).toMatchObject({ oldNo: 11 });
    expect(lines[1].newNo).toBeUndefined(); // a removal has no new line
    expect(lines[2]).toMatchObject({ oldNo: 12 });
    expect(lines[3]).toMatchObject({ newNo: 11 });
    expect(lines[3].oldNo).toBeUndefined(); // an addition has no old line
    // The context line after two removals and one addition.
    expect(lines[4]).toMatchObject({ oldNo: 13, newNo: 12 });
    expect(lines[5]).toMatchObject({ newNo: 13 });
  });

  it("reads several hunks", () => {
    const text = [
      "@@ -1,2 +1,2 @@",
      "-a",
      "+b",
      "@@ -20,2 +20,2 @@ in a function",
      "-c",
      "+d",
    ].join("\n");
    const hunks = parseUnifiedDiff(text);
    expect(hunks).toHaveLength(2);
    expect(hunks[1].lines[0]).toMatchObject({ kind: "remove", oldNo: 20 });
  });

  it("handles add-only and delete-only files", () => {
    const added = parseUnifiedDiff("@@ -0,0 +1,2 @@\n+one\n+two");
    expect(added[0].lines.every((l) => l.kind === "add")).toBe(true);

    const deleted = parseUnifiedDiff("@@ -1,2 +0,0 @@\n-one\n-two");
    expect(deleted[0].lines.every((l) => l.kind === "remove")).toBe(true);
  });

  it("treats a bare empty line as empty context", () => {
    const hunk = parseUnifiedDiff("@@ -1,3 +1,3 @@\n a\n\n b")[0];
    expect(hunk.lines.map((l) => l.kind)).toEqual(["context", "context", "context"]);
    expect(hunk.lines[1].text).toBe("");
    expect(hunk.lines[2]).toMatchObject({ oldNo: 3, newNo: 3 });
  });

  it("ignores the no-newline marker", () => {
    const hunk = parseUnifiedDiff("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b")[0];
    expect(hunk.lines.map((l) => l.kind)).toEqual(["remove", "add"]);
  });

  it("returns nothing for empty or headerless input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("diff --git a/x b/x\nindex 1..2 100644")).toEqual([]);
  });
});

describe("toSideBySide", () => {
  it("puts context on both sides and pairs a change across", () => {
    const rows = toSideBySide(parseUnifiedDiff(MIXED)[0]);
    expect(rows[0].left).toBe(rows[0].right); // context

    // Two removals against one addition: the second removal stands alone.
    expect(rows[1].left?.text).toBe("  const gone = 2;");
    expect(rows[1].right?.text).toBe("  const fresh = 2;");
    expect(rows[2].left?.text).toBe("  const also = 3;");
    expect(rows[2].right).toBeUndefined();

    // Then context, then a lone addition on the right.
    expect(rows[3].left?.kind).toBe("context");
    expect(rows[4].left).toBeUndefined();
    expect(rows[4].right?.text).toBe("  const extra = 5;");
  });

  it("spills extra additions into rows with an empty left side", () => {
    const hunk = parseUnifiedDiff("@@ -1,1 +1,3 @@\n-a\n+b\n+c\n+d")[0];
    const rows = toSideBySide(hunk);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ left: { text: "a" }, right: { text: "b" } });
    expect(rows[1].left).toBeUndefined();
    expect(rows[2].left).toBeUndefined();
  });
});

describe("countChanges", () => {
  it("counts added and removed lines across hunks", () => {
    expect(countChanges(parseUnifiedDiff(MIXED))).toEqual({ added: 2, removed: 2 });
    expect(countChanges([])).toEqual({ added: 0, removed: 0 });
  });
});
