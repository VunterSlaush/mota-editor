import { describe, expect, it } from "vitest";
import { isShellLine, shellCommand, shellKeystrokes } from "./shellLine";

describe("isShellLine", () => {
  it("recognises a draft that opens with the bang", () => {
    expect(isShellLine("!git status")).toBe(true);
  });

  it("leaves an ordinary prompt alone", () => {
    expect(isShellLine("what does git status say?")).toBe(false);
    expect(isShellLine("")).toBe(false);
  });

  it("lets a leading space send a prompt that starts with a bang", () => {
    expect(isShellLine(" !important, read this first")).toBe(false);
  });

  it("does not mistake a bang further along for one", () => {
    expect(isShellLine("run this! now")).toBe(false);
  });
});

describe("shellCommand", () => {
  it("is the line without its bang", () => {
    expect(shellCommand("!git status")).toBe("git status");
  });

  it("tolerates the space people type after the bang", () => {
    expect(shellCommand("! npm test  ")).toBe("npm test");
  });

  it("is empty when the bang stands alone, so there is nothing to run", () => {
    expect(shellCommand("!")).toBe("");
    expect(shellCommand("!   ")).toBe("");
  });

  it("is empty for a prompt, which is not its to answer", () => {
    expect(shellCommand("please run the tests")).toBe("");
  });
});

describe("shellKeystrokes", () => {
  it("submits the command with a carriage return", () => {
    expect(shellKeystrokes("npm test")).toBe("npm test\r");
  });

  it("submits every line of a pasted command, CR for each", () => {
    expect(shellKeystrokes("cd src\r\nls")).toBe("cd src\rls\r");
    expect(shellKeystrokes("cd src\nls")).toBe("cd src\rls\r");
  });
});
