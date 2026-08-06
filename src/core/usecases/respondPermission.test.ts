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
  async readTerminalOutput(): Promise<null> {
    return null;
  }
  async cancelTurn(): Promise<void> {}
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
    message: approvalMessage("Run npm test", "9", [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
    ]),
  });
  const gateway = new RecordingGateway();
  return { store, gateway, useCase: new RespondPermission(store, gateway) };
}

const DEFAULTS = projectDefaults(defaultSettings);

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

  it("ignores answers once the turn stranded the question", async () => {
    const { store, gateway, useCase } = questionSetup();
    store.dispatch({ type: "chat/approvalsCancelled", tabId: "t1" });
    expect(question(store)?.cancelled).toBe(true);

    await useCase.execute("t1", "12", { question_0: "Postgres" });

    expect(gateway.answers).toHaveLength(0);
  });
});
