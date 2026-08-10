import { describe, expect, it } from "vitest";
import { EMPTY_LINE, type InputLine, typeInto } from "./inputLine";

/** Apply keystrokes in order, the way the terminal sends them. */
const type = (...chunks: string[]): InputLine =>
  chunks.reduce<InputLine>(typeInto, EMPTY_LINE);

describe("tracking what was typed", () => {
  it("builds the line up character by character", () => {
    expect(type("n", "p", "m").text).toBe("npm");
  });

  it("takes a pasted chunk in one go", () => {
    expect(type("npm run build").text).toBe("npm run build");
  });

  it("backspace removes the last character, and stops at empty", () => {
    expect(type("npm", "\x7f").text).toBe("np");
    expect(type("n", "\b", "\b", "\b").text).toBe("");
  });

  it("keeps non-ASCII intact", () => {
    expect(type("echo café").text).toBe("echo café");
  });
});

describe("finishing a line", () => {
  it("reports the command and starts the next prompt empty", () => {
    const after = type("npm test", "\r");
    expect(after.submitted).toEqual(["npm test"]);
    expect(after.text).toBe("");
  });

  it("reports every command in a pasted script", () => {
    expect(type("cd app\rnpm test\r").submitted).toEqual(["cd app", "npm test"]);
  });

  it("ignores a bare Enter", () => {
    expect(type("\r").submitted).toEqual([]);
    expect(type("   ", "\r").submitted).toEqual([]);
  });

  it("only reports each command once", () => {
    const after = typeInto(type("npm test", "\r"), "g");
    expect(after.submitted).toEqual([]);
  });

  it("Ctrl+C abandons the line without running it", () => {
    const after = type("rm -rf /", "\x03");
    expect(after.submitted).toEqual([]);
    expect(after.text).toBe("");
  });
});

describe("failing closed", () => {
  // The point of the whole entity: a wrong guess would insert text the
  // user never typed, so anything unmodelled has to become "no idea".
  it.each([
    ["Tab completion", "\t"],
    ["an arrow key", "\x1b[C"],
    ["reverse search", "\x12"],
    ["history up", "\x1b[A"],
  ])("gives up after %s", (_name, keys) => {
    expect(type("np", keys).text).toBeNull();
  });

  it("stays lost for the rest of the line", () => {
    expect(type("np", "\t", "m", " ", "test").text).toBeNull();
  });

  it("does not report a command it stopped following", () => {
    const after = type("np", "\t", "\r");
    expect(after.submitted).toEqual([]);
  });

  it("recovers on the next prompt", () => {
    expect(type("np", "\t", "\r", "git").text).toBe("git");
  });

  it("still reports a command finished before it got lost", () => {
    const after = type("npm test", "\r\x1b[A");
    expect(after.submitted).toEqual(["npm test"]);
    expect(after.text).toBeNull();
  });
});
