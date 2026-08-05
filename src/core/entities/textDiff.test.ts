import { describe, expect, it } from "vitest";
import { countChanges, toSideBySide } from "./diff";
import { diffTexts } from "./textDiff";

describe("diffTexts", () => {
  it("returns no hunks for identical texts", () => {
    expect(diffTexts("a\nb\nc\n", "a\nb\nc\n")).toEqual([]);
  });

  it("pairs a changed line as remove + add with context around it", () => {
    const hunks = diffTexts("one\ntwo\nthree\nfour\n", "one\n2\nthree\nfour\n");
    expect(hunks).toHaveLength(1);
    const kinds = hunks[0].lines.map((l) => l.kind);
    expect(kinds).toEqual(["context", "remove", "add", "context", "context"]);
    expect(countChanges(hunks)).toEqual({ added: 1, removed: 1 });
    // The viewer's pairing puts the change on one row, read-across.
    const rows = toSideBySide(hunks[0]);
    const changed = rows.find((r) => r.left?.kind === "remove");
    expect(changed?.left?.text).toBe("two");
    expect(changed?.right?.text).toBe("2");
  });

  it("a created file is all additions", () => {
    const hunks = diffTexts("", "hello\nworld\n");
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.every((l) => l.kind === "add")).toBe(true);
    expect(hunks[0].header).toBe("@@ -1,0 +1,2 @@");
  });

  it("distant changes land in separate hunks", () => {
    const middle = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const oldText = `start\n${middle}\nend\n`;
    const newText = `START\n${middle}\nEND\n`;
    const hunks = diffTexts(oldText, newText);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].lines.some((l) => l.text === "START")).toBe(true);
    expect(hunks[1].lines.some((l) => l.text === "END")).toBe(true);
  });

  it("line numbers are 1-based and follow the change", () => {
    const hunks = diffTexts("a\nb\nc\n", "a\nb\nX\nc\n");
    const add = hunks[0].lines.find((l) => l.kind === "add");
    expect(add?.newNo).toBe(3);
    const header = hunks[0].header;
    expect(header).toBe("@@ -1,3 +1,4 @@");
  });

  it("oversized changes collapse to one replace block instead of hanging", () => {
    const big = (tag: string) =>
      Array.from({ length: 6000 }, (_, i) => `${tag} ${i}`).join("\n");
    const hunks = diffTexts(big("old"), big("new"));
    const { added, removed } = countChanges(hunks);
    expect(added).toBe(6000);
    expect(removed).toBe(6000);
  });
});
