import { describe, expect, it } from "vitest";
import { approvalMessage, questionMessage } from "../entities/message";
import { newProject } from "../entities/project";
import type {
  AgentGateway,
  AgentTurnEvent,
  AgentTurnRequest,
} from "../ports/agentGateway";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import { RespondPermission, RespondQuestion } from "./respondPermission";

class RecordingGateway implements AgentGateway {
  responses: Array<{ tabId: string; requestId: string; optionId: string }> = [];

  async startTurn(
    _request: AgentTurnRequest,
    _onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void> {}
  subscribeSessionEvents(): void {}
  subscribeAgentInitiated(): void {}
  async readTerminalOutput(): Promise<null> {
    return null;
  }
  cancelled: string[] = [];
  async cancelTurn(tabId: string): Promise<void> {
    this.cancelled.push(tabId);
  }
  async endSession(): Promise<void> {}
  async warmSession(): Promise<void> {}
  async listNativeSessions(): Promise<{ sessionId: string }[] | null> {
    return null;
  }
  async loadNativeSession(): Promise<{ replayed: boolean }> {
    return { replayed: true };
  }
  async respondPermission(tabId: string, requestId: string, optionId: string) {
    this.responses.push({ tabId, requestId, optionId });
  }

  answers: Array<{ requestId: string; answers: Record<string, string> }> = [];
  async respondQuestion(
    _tabId: string,
    requestId: string,
    answers: Readonly<Record<string, string>>,
  ) {
    this.answers.push({ requestId, answers: { ...answers } });
  }
}

function setup() {
  const store = new Store();
  store.dispatch({ type: "tab/opened", project: newProject("t1", "/a", DEFAULTS) });
  store.dispatch({
    type: "chat/messageAppended",
    tabId: "t1",
    message: approvalMessage("Run npm test", {
      requestId: "9",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    }),
  });
  const gateway = new RecordingGateway();
  return { store, gateway, useCase: new RespondPermission(store, gateway) };
}

const DEFAULTS = projectDefaults(defaultSettings);

const PLAN_OPTIONS = [
  { optionId: "acceptEdits", name: "Yes, auto-accept edits", kind: "allow_always" },
  { optionId: "plan", name: "No, keep planning", kind: "reject_once" },
];

/** A tab parked on a plan approval, as sendPrompt leaves it: the card is
 *  unanswered and the turn is not busy, because the agent is waiting. */
function planSetup() {
  const store = new Store();
  store.dispatch({ type: "tab/opened", project: newProject("t1", "/a", DEFAULTS) });
  store.dispatch({
    type: "chat/messageAppended",
    tabId: "t1",
    message: approvalMessage("Ready to code?", {
      requestId: "p1",
      options: PLAN_OPTIONS,
      isPlan: true,
    }),
  });
  const gateway = new RecordingGateway();
  return { store, gateway, useCase: new RespondPermission(store, gateway) };
}

const tabOf = (store: Store) => store.getState().tabs[0];

describe("answering a plan approval", () => {
  it("stops the agent when the plan is declined", async () => {
    const { store, gateway, useCase } = planSetup();
    await useCase.execute("t1", "p1", "plan");

    expect(gateway.responses).toEqual([
      { tabId: "t1", requestId: "p1", optionId: "plan" },
    ]);
    expect(gateway.cancelled).toEqual(["t1"]);
    expect(tabOf(store).busy).toBe(false);
  });

  it("says in the transcript that the agent stopped and is waiting", async () => {
    const { store, useCase } = planSetup();
    await useCase.execute("t1", "p1", "plan");

    const last = tabOf(store).messages.at(-1);
    expect(last?.role).toBe("info");
    expect(last?.text).toContain("waiting");
  });

  it("discards messages queued behind a plan that is then declined", async () => {
    const { store, useCase } = planSetup();
    store.dispatch({
      type: "chat/promptQueued",
      tabId: "t1",
      prompt: "and also this",
      attachments: [],
    });
    await useCase.execute("t1", "p1", "plan");

    expect(tabOf(store).queued).toEqual([]);
  });

  it("sets the agent working again when the plan is approved", async () => {
    const { store, gateway, useCase } = planSetup();
    await useCase.execute("t1", "p1", "acceptEdits");

    expect(gateway.cancelled).toEqual([]);
    expect(tabOf(store).busy).toBe(true);
  });

  it("leaves an ordinary tool denial alone — only a plan ends the turn", async () => {
    const { store, gateway, useCase } = setup();
    store.dispatch({ type: "chat/busyChanged", tabId: "t1", busy: true });
    await useCase.execute("t1", "9", "allow");

    expect(gateway.cancelled).toEqual([]);
    expect(tabOf(store).busy).toBe(true);
  });
});

describe("RespondPermission", () => {
  it("delivers the choice and marks the approval answered", async () => {
    const { store, gateway, useCase } = setup();

    await useCase.execute("t1", "9", "allow");

    expect(gateway.responses).toEqual([
      { tabId: "t1", requestId: "9", optionId: "allow" },
    ]);
    const approval = store.getState().tabs[0].messages[0].approval;
    expect(approval?.resolvedOptionId).toBe("allow");
  });

  it("ignores a second answer to the same request", async () => {
    const { gateway, useCase } = setup();

    await useCase.execute("t1", "9", "allow");
    await useCase.execute("t1", "9", "reject");

    expect(gateway.responses).toHaveLength(1);
  });

  it("ignores answers to cancelled approvals", async () => {
    const { store, gateway, useCase } = setup();
    store.dispatch({ type: "chat/approvalsCancelled", tabId: "t1" });

    await useCase.execute("t1", "9", "allow");

    expect(gateway.responses).toHaveLength(0);
  });

  // A restarted agent counts request ids from zero again, so the same id
  // can sit on a card answered an hour ago. The click belongs to the card
  // still waiting, not to that one.
  it("answers the live card when an older one wears the same request id", async () => {
    const { store, gateway, useCase } = setup();
    await useCase.execute("t1", "9", "allow");
    store.dispatch({
      type: "chat/messageAppended",
      tabId: "t1",
      message: approvalMessage("Run npm run build", {
        requestId: "9",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      }),
    });

    await useCase.execute("t1", "9", "reject");

    expect(gateway.responses).toHaveLength(2);
    const [older, live] = tabOf(store).messages;
    expect(older.approval?.resolvedOptionId).toBe("allow");
    expect(live.approval?.resolvedOptionId).toBe("reject");
  });
});

function questionSetup() {
  const store = new Store();
  store.dispatch({ type: "tab/opened", project: newProject("t1", "/a", DEFAULTS) });
  store.dispatch({
    type: "chat/messageAppended",
    tabId: "t1",
    message: questionMessage("Which database?", "12", [
      {
        field: "question_0",
        text: "Which database?",
        multiSelect: false,
        options: [
          { value: "Postgres", label: "Postgres" },
          { value: "SQLite", label: "SQLite" },
        ],
      },
    ]),
  });
  const gateway = new RecordingGateway();
  return { store, gateway, useCase: new RespondQuestion(store, gateway) };
}

const question = (store: Store) => store.getState().tabs[0].messages[0].question;

describe("RespondQuestion", () => {
  it("delivers the answers and marks the card answered", async () => {
    const { store, gateway, useCase } = questionSetup();

    await useCase.execute("t1", "12", { question_0: "Postgres" });

    expect(gateway.answers).toEqual([
      { requestId: "12", answers: { question_0: "Postgres" } },
    ]);
    expect(question(store)?.answers).toEqual({ question_0: "Postgres" });
    expect(question(store)?.skipped).toBe(false);
  });

  it("an empty answer is a deliberate skip, still sent to the agent", async () => {
    const { store, gateway, useCase } = questionSetup();

    await useCase.execute("t1", "12", {});

    // The agent must hear about it — silence would hang its tool call.
    expect(gateway.answers).toHaveLength(1);
    expect(question(store)?.skipped).toBe(true);
  });

  it("ignores a second answer to the same question", async () => {
    const { gateway, useCase } = questionSetup();

    await useCase.execute("t1", "12", { question_0: "Postgres" });
    await useCase.execute("t1", "12", { question_0: "SQLite" });

    expect(gateway.answers).toHaveLength(1);
  });

  // The bug this guards: request ids belong to the agent process, and a
  // restarted session hands out "0" again while the answered card from
  // the last one is still in the transcript. Matching the first card left
  // the live one unanswerable — the Answer button did nothing at all.
  it("answers the live card when an older one wears the same request id", async () => {
    const { store, gateway, useCase } = questionSetup();
    await useCase.execute("t1", "12", { question_0: "Postgres" });
    store.dispatch({
      type: "chat/messageAppended",
      tabId: "t1",
      message: questionMessage("Which extras?", "12", [
        {
          field: "question_0",
          text: "Which extras?",
          multiSelect: true,
          options: [
            { value: "lint", label: "lint" },
            { value: "test", label: "test" },
          ],
        },
      ]),
    });

    await useCase.execute("t1", "12", { question_0: "lint, test" });

    expect(gateway.answers).toHaveLength(2);
    const [older, live] = tabOf(store).messages;
    expect(older.question?.answers).toEqual({ question_0: "Postgres" });
    expect(live.question?.answers).toEqual({ question_0: "lint, test" });
  });

  it("ignores answers once the turn stranded the question", async () => {
    const { store, gateway, useCase } = questionSetup();
    store.dispatch({ type: "chat/approvalsCancelled", tabId: "t1" });
    expect(question(store)?.cancelled).toBe(true);

    await useCase.execute("t1", "12", { question_0: "Postgres" });

    expect(gateway.answers).toHaveLength(0);
  });
});
