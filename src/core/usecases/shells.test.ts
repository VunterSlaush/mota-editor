import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type { ShellHistorySource } from "../ports/shellHistorySource";
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

/** Test double — the shell's history file, scripted per test. */
class FakePastCommands implements ShellHistorySource {
  constructor(private readonly lines: readonly string[] = []) {}
  reads = 0;
  async recent(): Promise<readonly string[]> {
    this.reads += 1;
    return this.lines;
  }
}

function setUp(past: readonly string[] = []) {
  const store = new Store();
  const project = newProject("tab-1", "G:/repos/thing", DEFAULTS);
  store.dispatch({ type: "tab/opened", project });
  const port = new FakeShellPort();
  const pastCommands = new FakePastCommands(past);
  return {
    store,
    port,
    pastCommands,
    shells: new Shells(store, port, pastCommands),
    tabId: project.id,
  };
}

/** Collects the greyed-out suggestion as the use case revises it. */
function suggestionSpy() {
  const seen: string[] = [];
  return {
    seen,
    latest: () => seen[seen.length - 1] ?? "",
    request: (onSuggest: (s: string) => void) => ({
      size: SIZE,
      onOutput: () => undefined,
      onSuggest,
    }),
  };
}

const shellsOf = (store: Store, tabId: string) =>
  tabById(store.getState(), tabId)?.shells ?? [];
const activeShellOf = (store: Store, tabId: string) =>
  tabById(store.getState(), tabId)?.activeShellId;

describe("opening a terminal", () => {
  it("opens it in the project's folder", async () => {
    const { port, shells, tabId } = setUp();
    await shells.open(tabId, {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });
    expect(port.opened[0]?.cwd).toBe("G:/repos/thing");
    expect(port.opened[0]?.projectId).toBe(tabId);
  });

  it("names it and makes it the one you are looking at", async () => {
    const { store, shells, tabId } = setUp();
    await shells.open(tabId, {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });
    await shells.open(tabId, {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });
    expect(shellsOf(store, tabId).map((s) => s.title)).toEqual([
      "Terminal 1",
      "Terminal 2",
    ]);
    expect(activeShellOf(store, tabId)).toBe("shell-2");
  });

  it("passes the configured shell only when one is set", async () => {
    const { store, port, shells, tabId } = setUp();
    await shells.open(tabId, {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });
    expect(port.opened[0]?.shellPath).toBeUndefined();

    store.dispatch({ type: "settings/changed", patch: { terminalShell: "  /bin/zsh " } });
    await shells.open(tabId, {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });
    expect(port.opened[1]?.shellPath).toBe("/bin/zsh");
  });

  it("reports why it could not open instead of throwing at the view", async () => {
    const { store, port, shells, tabId } = setUp();
    port.failOpenWith = "Could not find a shell to run.";
    const result = await shells.open(tabId, {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });
    expect(result).toEqual({ ok: false, message: "Could not find a shell to run." });
    expect(shellsOf(store, tabId)).toEqual([]);
  });

  it("refuses a tab that is not open", async () => {
    const { shells } = setUp();
    const result = await shells.open("gone", {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });
    expect(result.ok).toBe(false);
  });

  it("still records an exit that beat the open call back", async () => {
    const { store, port, shells, tabId } = setUp();
    port.exitDuringOpen = 127;
    await shells.open(tabId, {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });
    expect(shellsOf(store, tabId)[0]?.exit).toEqual({ code: 127 });
  });
});

describe("a running terminal", () => {
  it("sends output to the view and never to the store", async () => {
    const { store, port, shells, tabId } = setUp();
    const received: Uint8Array[] = [];
    await shells.open(tabId, {
      size: SIZE,
      onOutput: (bytes) => received.push(bytes),
      onSuggest: () => undefined,
    });
    const before = store.getState();

    port.emitOutput("shell-1", new Uint8Array([104, 105]));

    expect(received).toEqual([new Uint8Array([104, 105])]);
    expect(store.getState()).toBe(before);
  });

  it("carries keystrokes and resizes through", async () => {
    const { port, shells, tabId } = setUp();
    await shells.open(tabId, {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });
    shells.write("shell-1", "ls\r");
    shells.resize("shell-1", { cols: 120, rows: 40 });
    expect(port.written).toEqual([{ sessionId: "shell-1", data: "ls\r" }]);
    expect(port.resized).toEqual([
      { sessionId: "shell-1", size: { cols: 120, rows: 40 } },
    ]);
  });

  it("keeps the session listed once the shell exits, so its output survives", async () => {
    const { store, port, shells, tabId } = setUp();
    await shells.open(tabId, {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });
    port.emitExit("shell-1", 1);
    expect(shellsOf(store, tabId)).toHaveLength(1);
    expect(shellsOf(store, tabId)[0]?.exit).toEqual({ code: 1 });
  });
});

describe("closing a terminal", () => {
  it("kills the shell and drops it from the strip", async () => {
    const { store, port, shells, tabId } = setUp();
    await shells.open(tabId, {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });
    await shells.close(tabId, "shell-1");
    expect(port.closed).toEqual(["shell-1"]);
    expect(shellsOf(store, tabId)).toEqual([]);
    expect(activeShellOf(store, tabId)).toBeUndefined();
  });

  it("selects the neighbour that is left", async () => {
    const { store, shells, tabId } = setUp();
    await shells.open(tabId, {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });
    await shells.open(tabId, {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });
    await shells.close(tabId, "shell-2");
    expect(activeShellOf(store, tabId)).toBe("shell-1");
  });

  it("leaves the selection alone when another terminal is closed", async () => {
    const { store, shells, tabId } = setUp();
    await shells.open(tabId, {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });
    await shells.open(tabId, {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });
    shells.select(tabId, "shell-1");
    await shells.close(tabId, "shell-2");
    expect(activeShellOf(store, tabId)).toBe("shell-1");
  });
});

describe("running a line typed at the prompt", () => {
  const open = (shells: Shells, tabId: string) =>
    shells.open(tabId, {
      size: SIZE,
      onOutput: () => undefined,
      onSuggest: () => undefined,
    });

  it("types it into the terminal the user is looking at", async () => {
    const { port, shells, tabId } = setUp();
    await open(shells, tabId);

    shells.runLine(tabId, "git status");

    expect(port.written).toEqual([{ sessionId: "shell-1", data: "git status\r" }]);
  });

  it("brings that terminal forward, since the output is the point", async () => {
    const { store, shells, tabId } = setUp();
    await open(shells, tabId);
    await open(shells, tabId);
    shells.select(tabId, "shell-1");

    shells.runLine(tabId, "git status");

    expect(activeShellOf(store, tabId)).toBe("shell-1");
  });

  it("holds it back until there is a terminal to run it in", async () => {
    const { store, port, shells, tabId } = setUp();

    shells.runLine(tabId, "npm test");

    expect(port.written).toEqual([]);
    expect(tabById(store.getState(), tabId)?.pendingShellLine).toBe("npm test");
  });

  it("runs the held line in the next terminal that opens", async () => {
    const { store, port, shells, tabId } = setUp();
    shells.runLine(tabId, "npm test");

    await open(shells, tabId);

    expect(port.written).toEqual([{ sessionId: "shell-1", data: "npm test\r" }]);
    expect(tabById(store.getState(), tabId)?.pendingShellLine).toBeUndefined();
  });

  it("keeps it out of a terminal that is busy — a server would eat it", async () => {
    const { store, port, shells, tabId } = setUp();
    await open(shells, tabId);
    shells.write("shell-1", "npm run dev\r"); // that terminal is taken now

    shells.runLine(tabId, "git status");

    expect(port.written.map((w) => w.data)).toEqual(["npm run dev\r"]);
    expect(tabById(store.getState(), tabId)?.pendingShellLine).toBe("git status");
  });

  it("prefers a free terminal over the busy one in front", async () => {
    const { store, port, shells, tabId } = setUp();
    await open(shells, tabId);
    await open(shells, tabId);
    shells.select(tabId, "shell-2");
    shells.write("shell-2", "npm run dev\r");

    shells.runLine(tabId, "git status");

    expect(port.written.at(-1)).toEqual({ sessionId: "shell-1", data: "git status\r" });
    expect(activeShellOf(store, tabId)).toBe("shell-1");
  });

  it("will not type into a shell that has exited", async () => {
    const { store, port, shells, tabId } = setUp();
    await open(shells, tabId);
    port.emitExit("shell-1", 0);

    shells.runLine(tabId, "git status");

    expect(port.written).toEqual([]);
    expect(tabById(store.getState(), tabId)?.pendingShellLine).toBe("git status");
  });

  it("learns the command, like any other the terminal has run", async () => {
    const { shells, tabId } = setUp();
    const spy = suggestionSpy();
    await shells.open(
      tabId,
      spy.request((s) => spy.seen.push(s)),
    );

    shells.runLine(tabId, "cargo clippy");
    shells.write("shell-1", "car");

    expect(spy.latest()).toBe("go clippy");
  });

  it("keeps it waiting when the terminal that opened was dead on arrival", async () => {
    const { store, port, shells, tabId } = setUp();
    shells.runLine(tabId, "npm test");
    port.exitDuringOpen = 127; // a shell path that does not exist

    await open(shells, tabId);

    expect(port.written).toEqual([]);
    expect(tabById(store.getState(), tabId)?.pendingShellLine).toBe("npm test");
  });

  it("has nothing to run for a bare bang", async () => {
    const { store, port, shells, tabId } = setUp();
    await open(shells, tabId);

    shells.runLine(tabId, "");

    expect(port.written).toEqual([]);
    expect(tabById(store.getState(), tabId)?.pendingShellLine).toBeUndefined();
  });

  it("ignores a tab that is not open", () => {
    const { store, shells } = setUp();
    shells.runLine("gone", "git status");
    expect(store.getState().tabs).toHaveLength(1);
  });
});

describe("suggesting the next command", () => {
  const past = ["git status", "npm run build", "npm test", "npm test", "npm test"];

  it("suggests the most-used command matching what has been typed", async () => {
    const { shells, tabId } = setUp(past);
    const spy = suggestionSpy();
    await shells.open(
      tabId,
      spy.request((s) => spy.seen.push(s)),
    );

    shells.write("shell-1", "npm ");

    expect(spy.latest()).toBe("test");
  });

  it("narrows as more is typed", async () => {
    const { shells, tabId } = setUp(past);
    const spy = suggestionSpy();
    await shells.open(
      tabId,
      spy.request((s) => spy.seen.push(s)),
    );

    shells.write("shell-1", "npm r");

    expect(spy.latest()).toBe("un build");
  });

  it("clears the suggestion when nothing matches", async () => {
    const { shells, tabId } = setUp(past);
    const spy = suggestionSpy();
    await shells.open(
      tabId,
      spy.request((s) => spy.seen.push(s)),
    );

    shells.write("shell-1", "cargo");

    expect(spy.latest()).toBe("");
  });

  it("stops suggesting once it has lost track of the line", async () => {
    const { shells, tabId } = setUp(past);
    const spy = suggestionSpy();
    await shells.open(
      tabId,
      spy.request((s) => spy.seen.push(s)),
    );

    shells.write("shell-1", "npm ");
    expect(spy.latest()).toBe("test");
    shells.write("shell-1", "\t"); // Tab: the shell rewrites the line

    expect(spy.latest()).toBe("");
  });

  it("accepting types the rest of the command into the shell", async () => {
    const { port, shells, tabId } = setUp(past);
    const spy = suggestionSpy();
    await shells.open(
      tabId,
      spy.request((s) => spy.seen.push(s)),
    );

    shells.write("shell-1", "npm ");
    shells.acceptSuggestion("shell-1");

    expect(port.written.map((w) => w.data).join("")).toBe("npm test");
    expect(spy.latest()).toBe("");
  });

  it("accepting nothing sends nothing", async () => {
    const { port, shells, tabId } = setUp(past);
    const spy = suggestionSpy();
    await shells.open(
      tabId,
      spy.request((s) => spy.seen.push(s)),
    );

    shells.write("shell-1", "cargo");
    shells.acceptSuggestion("shell-1");

    expect(port.written.map((w) => w.data).join("")).toBe("cargo");
  });

  it("learns a command it watched being run", async () => {
    const { shells, tabId } = setUp();
    const spy = suggestionSpy();
    await shells.open(
      tabId,
      spy.request((s) => spy.seen.push(s)),
    );

    shells.write("shell-1", "cargo clippy\r");
    shells.write("shell-1", "car");

    expect(spy.latest()).toBe("go clippy");
  });

  it("shares what it learned with a terminal opened later", async () => {
    const { shells, tabId } = setUp();
    const first = suggestionSpy();
    await shells.open(
      tabId,
      first.request((s) => first.seen.push(s)),
    );
    shells.write("shell-1", "cargo clippy\r");

    const second = suggestionSpy();
    await shells.open(
      tabId,
      second.request((s) => second.seen.push(s)),
    );
    shells.write("shell-2", "car");

    expect(second.latest()).toBe("go clippy");
  });

  it("reads the shell's history file only once, however many terminals open", async () => {
    const { shells, pastCommands, tabId } = setUp(past);
    const spy = suggestionSpy();
    await shells.open(
      tabId,
      spy.request((s) => spy.seen.push(s)),
    );
    await shells.open(
      tabId,
      spy.request((s) => spy.seen.push(s)),
    );

    expect(pastCommands.reads).toBe(1);
  });

  it("says nothing at all when suggestions are switched off", async () => {
    const { store, shells, tabId } = setUp(past);
    store.dispatch({
      type: "settings/changed",
      patch: { terminalSuggestions: false },
    });
    const spy = suggestionSpy();
    await shells.open(
      tabId,
      spy.request((s) => spy.seen.push(s)),
    );

    shells.write("shell-1", "npm ");

    expect(spy.latest()).toBe("");
  });

  it("does not open the history file at all when suggestions are off", async () => {
    const { store, shells, pastCommands, tabId } = setUp(past);
    store.dispatch({
      type: "settings/changed",
      patch: { terminalSuggestions: false },
    });
    const spy = suggestionSpy();
    await shells.open(
      tabId,
      spy.request((s) => spy.seen.push(s)),
    );
    shells.write("shell-1", "npm ");

    expect(pastCommands.reads).toBe(0);
  });
});
