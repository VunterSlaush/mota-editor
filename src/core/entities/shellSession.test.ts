import { describe, expect, it } from "vitest";
import { EMPTY_LINE, type InputLine, typeInto } from "./inputLine";
import type { ShellSession } from "./shellSession";
import {
  nextShellTitle,
  shellAfterClosing,
  shellExitLabel,
  shellRunningAfter,
} from "./shellSession";

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

describe("shellRunningAfter", () => {
  /** Send keystrokes the way the terminal does, through the line model. */
  const send = (running: boolean, keystrokes: readonly string[]) => {
    let line: InputLine = EMPTY_LINE;
    let state = running;
    for (const data of keystrokes) {
      line = typeInto(line, data);
      state = shellRunningAfter(state, data, line);
    }
    return state;
  };

  it("is not running at a fresh prompt", () => {
    expect(send(false, ["l", "s"])).toBe(false);
  });

  it("runs once a command is submitted", () => {
    expect(send(false, ["l", "s", "\r"])).toBe(true);
  });

  it("keeps running while a server prints nothing", () => {
    // The case the indicator exists for: `npm run dev` occupies the
    // shell for hours without another keystroke.
    expect(send(false, ["n", "p", "m", " ", "d", "e", "v", "\r"])).toBe(true);
  });

  it("stops when the user types at the prompt they got back", () => {
    expect(send(true, ["l"])).toBe(false);
  });

  it("stops on Ctrl+C, which is how a server is killed", () => {
    expect(send(true, ["\x03"])).toBe(false);
  });

  it("ignores an arrow key, which is not typing", () => {
    // "\x1b[A" ends in printable characters that are not typed text —
    // reading them as typing would call a running command finished.
    expect(send(true, ["\x1b[A"])).toBe(true);
  });

  it("ignores a bare Enter: an empty prompt starts nothing", () => {
    expect(send(false, ["\r"])).toBe(false);
  });

  it("runs after a pasted command that arrives in one chunk", () => {
    expect(send(false, ["npm run dev\r"])).toBe(true);
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
