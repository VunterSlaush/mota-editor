import { describe, expect, it } from "vitest";
import {
  historyFrom,
  MAX_COMMANDS,
  predict,
  remember,
  suggestionSuffix,
} from "./shellHistory";

const lines = (history: ReturnType<typeof historyFrom>) => history.map((e) => e.line);

describe("ranking a history", () => {
  it("puts the most-used command first, whenever it was last run", () => {
    const history = historyFrom(["git status", "npm test", "npm test", "npm test"]);
    expect(lines(history)).toEqual(["npm test", "git status"]);
  });

  it("breaks a tie on how recently it was run", () => {
    const history = historyFrom(["npm test", "git status"]);
    expect(lines(history)).toEqual(["git status", "npm test"]);
  });

  it("counts each command once however often it repeats", () => {
    const history = historyFrom(["cls", "cls", "cls"]);
    expect(history).toHaveLength(1);
    expect(history[0].uses).toBe(3);
  });

  it("skips blanks and trims", () => {
    expect(lines(historyFrom(["", "  ", "  npm test  "]))).toEqual(["npm test"]);
  });

  it("keeps only the top commands when the history is long", () => {
    const many = Array.from({ length: MAX_COMMANDS + 50 }, (_, n) => `cmd${n}`);
    expect(historyFrom(many)).toHaveLength(MAX_COMMANDS);
  });
});

describe("remembering a new command", () => {
  it("adds one it has not seen", () => {
    const history = remember(historyFrom(["npm test"]), "git push");
    expect(lines(history)).toContain("git push");
  });

  it("promotes a repeat above the commands it ties with", () => {
    const history = remember(historyFrom(["a", "b", "c"]), "c");
    expect(lines(history)[0]).toBe("c");
  });

  it("ignores a blank", () => {
    const before = historyFrom(["npm test"]);
    expect(remember(before, "   ")).toBe(before);
  });
});

describe("predicting from a prefix", () => {
  const history = historyFrom([
    "git status",
    "npm test",
    "npm test",
    "npm run build",
    "npm run build",
    "npm run build",
  ]);

  it("returns the most-used command that starts with it", () => {
    expect(predict(history, "npm")).toBe("npm run build");
  });

  it("narrows as more is typed", () => {
    expect(predict(history, "npm t")).toBe("npm test");
  });

  it("suggests nothing for an empty or blank prefix", () => {
    expect(predict(history, "")).toBeNull();
    expect(predict(history, "   ")).toBeNull();
    expect(predict(history, null)).toBeNull();
  });

  it("suggests nothing when nothing matches", () => {
    expect(predict(history, "cargo")).toBeNull();
  });

  it("suggests nothing once the prefix is the whole command", () => {
    // Otherwise the key to accept it would do nothing at all.
    expect(predict(history, "npm test")).toBeNull();
  });

  it("is case-sensitive, because shells are", () => {
    expect(predict(history, "NPM")).toBeNull();
  });
});

describe("the suffix the user sees", () => {
  const history = historyFrom(["npm run build"]);

  it("is only the part still to type", () => {
    expect(suggestionSuffix(history, "npm r")).toBe("un build");
  });

  it("is empty when there is nothing to suggest", () => {
    expect(suggestionSuffix(history, "cargo")).toBe("");
    expect(suggestionSuffix(history, null)).toBe("");
  });
});
