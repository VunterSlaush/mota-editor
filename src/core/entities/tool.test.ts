import { describe, expect, it } from "vitest";
import { assistantMessage, toolCallMessage, toolMessage } from "./message";
import { agentEditedFiles, changesFiles, countFileChangingTools } from "./tool";

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

  it("trusts an ACP tool call's kind and diffs over its name", () => {
    const read = toolCallMessage("c1", "read", "Read config", "completed");
    const edit = toolCallMessage("c2", "edit", "Edit main", "completed");
    // A read-kind call that still reported a diff counts: the diff is
    // first-hand evidence the tree moved.
    const sneaky = {
      ...toolCallMessage("c3", "read", "odd", "completed"),
      toolCall: {
        ...toolCallMessage("c3", "read", "odd", "completed").toolCall!,
        content: [{ type: "diff" as const, path: "a.ts", newText: "x" }],
      },
    };
    expect(countFileChangingTools([read, edit, sneaky])).toBe(2);
  });
});

describe("agentEditedFiles", () => {
  it("collects reported diffs, newest per path winning", () => {
    const first = withContent(toolCallMessage("c1", "edit", "Edit a", "completed"), [
      { type: "diff", path: "/w/a.ts", oldText: "1", newText: "2" },
    ]);
    const second = withContent(
      toolCallMessage("c2", "edit", "Edit a again", "completed"),
      [{ type: "diff", path: "/w/a.ts", oldText: "2", newText: "3" }],
    );
    const files = agentEditedFiles([first, second]);
    expect(files).toHaveLength(1);
    expect(files[0].diff?.newText).toBe("3");
  });

  it("edit-kind locations count as touched files even without a diff", () => {
    const message = {
      ...toolCallMessage("c1", "edit", "Edit b", "completed"),
      toolCall: {
        ...toolCallMessage("c1", "edit", "Edit b", "completed").toolCall!,
        locations: [{ path: "/w/b.ts", line: 3 }],
      },
    };
    const files = agentEditedFiles([message]);
    expect(files).toEqual([{ path: "/w/b.ts" }]);
  });

  it("legacy tool rows contribute nothing", () => {
    expect(agentEditedFiles([toolMessage("Edit", "a.ts")])).toEqual([]);
  });
});

function withContent(
  message: ReturnType<typeof toolCallMessage>,
  content: NonNullable<ReturnType<typeof toolCallMessage>["toolCall"]>["content"],
) {
  return { ...message, toolCall: { ...message.toolCall!, content } };
}
