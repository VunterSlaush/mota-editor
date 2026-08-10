import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type {
  ShellOpenRequest,
  ShellPort,
  ShellSize,
  ShellStream,
} from "../ports/shellPort";
import { defaultSettings, projectDefaults, tabById } from "../state/appState";
import { Store } from "../state/store";
import { Shells } from "./shells";

const DEFAULTS = projectDefaults(defaultSettings);
const SIZE: ShellSize = { cols: 80, rows: 24 };

/** Test double — a scripted pty: it records, and it can be made to
 *  answer, fail, or die on the caller's cue. */
class FakeShellPort implements ShellPort {
  opened: ShellOpenRequest[] = [];
  written: Array<{ sessionId: string; data: string }> = [];
  resized: Array<{ sessionId: string; size: ShellSize }> = [];
  closed: string[] = [];
  closedProjects: string[] = [];
  failOpenWith: string | null = null;
  /** Exit reported from inside `open`, before it resolves. */
  exitDuringOpen: number | null | undefined;

  private streams = new Map<string, ShellStream>();
  private nextId = 1;

  async open(request: ShellOpenRequest, stream: ShellStream): Promise<string> {
    if (this.failOpenWith) throw new Error(this.failOpenWith);
    this.opened.push(request);
    const sessionId = `shell-${this.nextId++}`;
    this.streams.set(sessionId, stream);
    if (this.exitDuringOpen !== undefined) stream.onExit(this.exitDuringOpen);
    return sessionId;
  }
  async write(sessionId: string, data: string) {
    this.written.push({ sessionId, data });
  }
  async resize(sessionId: string, size: ShellSize) {
    this.resized.push({ sessionId, size });
  }
  async close(sessionId: string) {
    this.closed.push(sessionId);
  }
  async closeProject(projectId: string) {
    this.closedProjects.push(projectId);
  }

  emitOutput(sessionId: string, bytes: Uint8Array) {
    this.streams.get(sessionId)?.onOutput(bytes);
  }
  emitExit(sessionId: string, code: number | null) {
    this.streams.get(sessionId)?.onExit(code);
  }
}

function setUp() {
  const store = new Store();
  const project = newProject("tab-1", "G:/repos/thing", DEFAULTS);
  store.dispatch({ type: "tab/opened", project });
  const port = new FakeShellPort();
  return { store, port, shells: new Shells(store, port), tabId: project.id };
}

const shellsOf = (store: Store, tabId: string) =>
  tabById(store.getState(), tabId)?.shells ?? [];
const activeShellOf = (store: Store, tabId: string) =>
  tabById(store.getState(), tabId)?.activeShellId;

describe("opening a terminal", () => {
  it("opens it in the project's folder", async () => {
    const { port, shells, tabId } = setUp();
    await shells.open(tabId, { size: SIZE, onOutput: () => undefined });
    expect(port.opened[0]?.cwd).toBe("G:/repos/thing");
    expect(port.opened[0]?.projectId).toBe(tabId);
  });

  it("names it and makes it the one you are looking at", async () => {
    const { store, shells, tabId } = setUp();
    await shells.open(tabId, { size: SIZE, onOutput: () => undefined });
    await shells.open(tabId, { size: SIZE, onOutput: () => undefined });
    expect(shellsOf(store, tabId).map((s) => s.title)).toEqual([
      "Terminal 1",
      "Terminal 2",
    ]);
    expect(activeShellOf(store, tabId)).toBe("shell-2");
  });

  it("passes the configured shell only when one is set", async () => {
    const { store, port, shells, tabId } = setUp();
    await shells.open(tabId, { size: SIZE, onOutput: () => undefined });
    expect(port.opened[0]?.shellPath).toBeUndefined();

    store.dispatch({ type: "settings/changed", patch: { terminalShell: "  /bin/zsh " } });
    await shells.open(tabId, { size: SIZE, onOutput: () => undefined });
    expect(port.opened[1]?.shellPath).toBe("/bin/zsh");
  });

  it("reports why it could not open instead of throwing at the view", async () => {
    const { store, port, shells, tabId } = setUp();
    port.failOpenWith = "Could not find a shell to run.";
    const result = await shells.open(tabId, { size: SIZE, onOutput: () => undefined });
    expect(result).toEqual({ ok: false, message: "Could not find a shell to run." });
    expect(shellsOf(store, tabId)).toEqual([]);
  });

  it("refuses a tab that is not open", async () => {
    const { shells } = setUp();
    const result = await shells.open("gone", { size: SIZE, onOutput: () => undefined });
    expect(result.ok).toBe(false);
  });

  it("still records an exit that beat the open call back", async () => {
    const { store, port, shells, tabId } = setUp();
    port.exitDuringOpen = 127;
    await shells.open(tabId, { size: SIZE, onOutput: () => undefined });
    expect(shellsOf(store, tabId)[0]?.exit).toEqual({ code: 127 });
  });
});

describe("a running terminal", () => {
  it("sends output to the view and never to the store", async () => {
    const { store, port, shells, tabId } = setUp();
    const received: Uint8Array[] = [];
    await shells.open(tabId, { size: SIZE, onOutput: (bytes) => received.push(bytes) });
    const before = store.getState();

    port.emitOutput("shell-1", new Uint8Array([104, 105]));

    expect(received).toEqual([new Uint8Array([104, 105])]);
    expect(store.getState()).toBe(before);
  });

  it("carries keystrokes and resizes through", async () => {
    const { port, shells, tabId } = setUp();
    await shells.open(tabId, { size: SIZE, onOutput: () => undefined });
    shells.write("shell-1", "ls\r");
    shells.resize("shell-1", { cols: 120, rows: 40 });
    expect(port.written).toEqual([{ sessionId: "shell-1", data: "ls\r" }]);
    expect(port.resized).toEqual([
      { sessionId: "shell-1", size: { cols: 120, rows: 40 } },
    ]);
  });

  it("keeps the session listed once the shell exits, so its output survives", async () => {
    const { store, port, shells, tabId } = setUp();
    await shells.open(tabId, { size: SIZE, onOutput: () => undefined });
    port.emitExit("shell-1", 1);
    expect(shellsOf(store, tabId)).toHaveLength(1);
    expect(shellsOf(store, tabId)[0]?.exit).toEqual({ code: 1 });
  });
});

describe("closing a terminal", () => {
  it("kills the shell and drops it from the strip", async () => {
    const { store, port, shells, tabId } = setUp();
    await shells.open(tabId, { size: SIZE, onOutput: () => undefined });
    await shells.close(tabId, "shell-1");
    expect(port.closed).toEqual(["shell-1"]);
    expect(shellsOf(store, tabId)).toEqual([]);
    expect(activeShellOf(store, tabId)).toBeUndefined();
  });

  it("selects the neighbour that is left", async () => {
    const { store, shells, tabId } = setUp();
    await shells.open(tabId, { size: SIZE, onOutput: () => undefined });
    await shells.open(tabId, { size: SIZE, onOutput: () => undefined });
    await shells.close(tabId, "shell-2");
    expect(activeShellOf(store, tabId)).toBe("shell-1");
  });

  it("leaves the selection alone when another terminal is closed", async () => {
    const { store, shells, tabId } = setUp();
    await shells.open(tabId, { size: SIZE, onOutput: () => undefined });
    await shells.open(tabId, { size: SIZE, onOutput: () => undefined });
    shells.select(tabId, "shell-1");
    await shells.close(tabId, "shell-2");
    expect(activeShellOf(store, tabId)).toBe("shell-1");
  });
});
