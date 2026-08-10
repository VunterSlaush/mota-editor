import { describe, expect, it } from "vitest";
import type { ShellSession } from "./shellSession";
import { nextShellTitle, shellAfterClosing, shellExitLabel } from "./shellSession";

const session = (id: string, title: string, exit?: { code: number | null }) =>
  ({ id, title, ...(exit ? { exit } : {}) }) satisfies ShellSession;

describe("nextShellTitle", () => {
  it("starts at one", () => {
    expect(nextShellTitle([])).toBe("Terminal 1");
  });

  it("counts up while every number is taken", () => {
    const open = [session("a", "Terminal 1"), session("b", "Terminal 2")];
    expect(nextShellTitle(open)).toBe("Terminal 3");
  });

  it("fills the gap a closed terminal left behind", () => {
    const open = [session("a", "Terminal 1"), session("c", "Terminal 3")];
    expect(nextShellTitle(open)).toBe("Terminal 2");
  });
});

describe("shellExitLabel", () => {
  it("says nothing while the shell is running", () => {
    expect(shellExitLabel(session("a", "Terminal 1"))).toBe("");
  });

  it("shows the code only when it is a failure", () => {
    expect(shellExitLabel(session("a", "Terminal 1", { code: 0 }))).toBe("exited");
    expect(shellExitLabel(session("a", "Terminal 1", { code: 1 }))).toBe("exited (1)");
  });

  it("says plainly that a killed shell exited", () => {
    expect(shellExitLabel(session("a", "Terminal 1", { code: null }))).toBe("exited");
  });
});

describe("shellAfterClosing", () => {
  const open = [
    session("a", "Terminal 1"),
    session("b", "Terminal 2"),
    session("c", "Terminal 3"),
  ];

  it("moves to the neighbour on the left", () => {
    expect(shellAfterClosing(open, "b")).toBe("a");
  });

  it("moves right when the closed one was first", () => {
    expect(shellAfterClosing(open, "a")).toBe("b");
  });

  it("has nothing to select once the last one goes", () => {
    expect(shellAfterClosing([session("a", "Terminal 1")], "a")).toBeUndefined();
  });
});
