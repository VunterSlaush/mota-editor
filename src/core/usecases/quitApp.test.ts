import { describe, expect, it } from "vitest";
import type { WindowPort } from "../ports/windowPort";
import { firstChatId, type TabState } from "../state/appState";
import { Store } from "../state/store";
import { QuitApp } from "./quitApp";

class FakeWindow implements WindowPort {
  handler: (() => void) | null = null;
  closed = 0;
  onCloseRequested(handler: () => void): void {
    this.handler = handler;
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

function tab(id: string, over: Partial<TabState> = {}): TabState {
  return {
    project: {
      id,
      path: `/work/${id}`,
      name: id,
      provider: "claude",
      mode: "agent",
      permission: "manual",
      verbose: true,
      providerSessions: {},
    },
    chatId: firstChatId(id),
    messages: [],
    busy: false,
    queued: [],
    agentCommands: [],
    plan: [],
    shells: [],
    ...over,
  };
}

function guarded(tabs: readonly TabState[]) {
  const store = new Store();
  store.dispatch({
    type: "workspace/restored",
    tabs,
    activeTabId: tabs[0]?.project.id ?? null,
    settings: store.getState().settings,
  });
  const window = new FakeWindow();
  const blocked: (readonly TabState[])[] = [];
  new QuitApp(store, window).guard((working) => blocked.push(working));
  return { window, blocked };
}

describe("QuitApp", () => {
  it("gets out of the way when every tab is idle", () => {
    const { window, blocked } = guarded([tab("alpha"), tab("beta")]);

    window.handler?.();

    expect(window.closed).toBe(1);
    expect(blocked).toEqual([]);
  });

  it("stops and names the tabs still running a turn", () => {
    const { window, blocked } = guarded([
      tab("alpha"),
      tab("beta", { busy: true }),
      tab("gamma", { busy: true }),
    ]);

    window.handler?.();

    expect(window.closed).toBe(0);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].map((t) => t.project.id)).toEqual(["beta", "gamma"]);
  });

  it("counts a prompt waiting behind a finished turn as work in flight", () => {
    // Nothing is streaming, but the queue is about to start a turn the
    // user typed and walked away from — losing it is losing work.
    const { window, blocked } = guarded([
      tab("alpha", { queued: [{ prompt: "then deploy", attachments: [] }] }),
    ]);

    window.handler?.();

    expect(window.closed).toBe(0);
    expect(blocked[0].map((t) => t.project.id)).toEqual(["alpha"]);
  });

  it("does not ask again once the user has said to go", async () => {
    const { window } = guarded([tab("alpha", { busy: true })]);
    window.handler?.();

    const store = new Store();
    await new QuitApp(store, window).execute();

    expect(window.closed).toBe(1);
  });
});
