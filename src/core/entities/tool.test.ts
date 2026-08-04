import { describe, expect, it } from "vitest";
import { changesFiles, countFileChangingTools } from "./tool";
import { assistantMessage, toolMessage } from "./message";

describe("changesFiles", () => {
  it("recognises the editing tools", () => {
    for (const name of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(changesFiles(name)).toBe(true);
    }
  });

  it("recognises the other providers' editing tools", () => {
    for (const name of ["apply_patch", "write_file", "replace", "create_file"]) {
      expect(changesFiles(name)).toBe(true);
    }
  });

  it("treats shell tools as file-changing, since they can do anything", () => {
    for (const name of ["Bash", "run_shell_command", "Terminal"]) {
      expect(changesFiles(name)).toBe(true);
    }
  });

  it("leaves read-only tools alone", () => {
    for (const name of ["Read", "Grep", "Glob", "WebFetch", "TodoWrite", "Task"]) {
      expect(changesFiles(name)).toBe(false);
    }
  });

  it("ignores case and surrounding punctuation", () => {
    expect(changesFiles("edit")).toBe(true);
    expect(changesFiles("str_replace_editor")).toBe(true);
  });

  it("says no when the tool has no name", () => {
    expect(changesFiles(undefined)).toBe(false);
    expect(changesFiles("")).toBe(false);
  });
});

describe("countFileChangingTools", () => {
  it("counts only the tool messages that change files", () => {
    const messages = [
      assistantMessage("working on it"),
      toolMessage("Read", "src/main.tsx"),
      toolMessage("Edit", "src/main.tsx"),
      toolMessage("Bash", "npm test"),
    ];
    expect(countFileChangingTools(messages)).toBe(2);
  });

  it("is zero for a conversation that touched nothing", () => {
    expect(countFileChangingTools([assistantMessage("hello")])).toBe(0);
    expect(countFileChangingTools([])).toBe(0);
  });
});
