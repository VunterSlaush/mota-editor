import type { BilledRequest } from "../../core/entities/billing";
import type { CommandInfo } from "../../core/entities/command";
import type { SessionStats, TurnStat } from "../../core/entities/insights";
import type { McpServerSpec } from "../../core/entities/mcpServer";
import type { ProviderId } from "../../core/entities/provider";
import type {
  AgentGateway,
  AgentTurnEvent,
  AgentTurnRequest,
} from "../../core/ports/agentGateway";
import type { BillingStore } from "../../core/ports/billingStore";
import type { CommandCatalog } from "../../core/ports/commandCatalog";
import type { GitBranch, GitChange, GitCommit, GitPort } from "../../core/ports/gitPort";
import type { McpProbe, McpProbeResult } from "../../core/ports/mcpProbe";
import type { NotificationPort } from "../../core/ports/notificationPort";
import type { ProviderProbe, ProviderStatus } from "../../core/ports/providerProbe";
import type {
  PersistedTranscript,
  TranscriptMeta,
  TranscriptStore,
} from "../../core/ports/transcriptStore";
import type {
  FilePicker,
  FolderPicker,
  PastedImageStore,
  PersistedWorkspace,
  WorkspaceStore,
} from "../../core/ports/workspacePort";

/**
 * Demo adapters — in-memory implementations of every port, used when the
 * UI runs in a plain browser (no Tauri backend). They make the full app
 * usable for UI development and automated UI tests: a scripted agent
 * streams deltas, uses tools, asks for permission, publishes plans and
 * usage — reacting like the real thing, without any process or network.
 */

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DemoAgentGateway implements AgentGateway {
  private cancelled = new Set<string>();
  private pendingPermissions = new Map<string, (optionId: string) => void>();
  private pendingQuestions = new Map<string, (answers: Record<string, string>) => void>();
  private questionSeq = 1;
  private planSeq = 1;

  async startTurn(
    request: AgentTurnRequest,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void> {
    this.cancelled.delete(request.tabId);
    void this.run(request, onEvent);
  }

  subscribeSessionEvents(): void {} // demo sessions have no warm-up

  async readTerminalOutput(): Promise<null> {
    return null; // demo agents own no terminals
  }

  private async run(
    request: AgentTurnRequest,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void> {
    const stopped = () => this.cancelled.has(request.tabId);
    const emit = (event: AgentTurnEvent) => {
      if (!stopped()) onEvent(event);
    };

    await delay(150);
    emit({ kind: "usage", used: 32_000, size: 200_000 });

    // "fail" simulates a transient provider outage, so the error state
    // (and the red tab dot) can be seen in the browser preview without
    // having to break a real agent.
    if (/\bfail\b/i.test(request.prompt)) {
      await delay(200);
      emit({
        kind: "error",
        message:
          "API Error: 522 connection timed out — the provider could not be reached. This is usually temporary.",
      });
      emit({ kind: "completed", isError: true });
      return;
    }

    const wantsPlan = /\bplan\b/i.test(request.prompt) || request.mode === "plan";
    const wantsPermission = /\b(run|delete|install|deploy)\b/i.test(request.prompt);
    const wantsQuestion = /\b(ask|choose|which|prefer)\b/i.test(request.prompt);

    for (const text of ["Let me look at ", "the project first."]) {
      await delay(120);
      emit({ kind: "thoughtDelta", text });
    }
    await delay(150);
    emit({ kind: "tool", name: "read", detail: "Reading src/main.ts" });

    if (wantsPlan) {
      await delay(200);
      emit({
        kind: "plan",
        entries: [
          {
            content: "Inspect the current implementation",
            priority: "medium",
            status: "completed",
          },
          { content: "Apply the change", priority: "high", status: "in_progress" },
          { content: "Run the tests", priority: "medium", status: "pending" },
        ],
      });
    }

    if (wantsQuestion) {
      await delay(200);
      const requestId = `demo-q-${this.questionSeq++}`;
      emit({
        kind: "question",
        requestId,
        message: "Which database should I use?",
        questions: [
          {
            field: "question_0",
            header: "Database",
            text: "Which database should I use?",
            multiSelect: false,
            customField: "question_0_custom",
            options: [
              {
                value: "Postgres",
                label: "Postgres",
                description: "Relational, best for joins",
              },
              { value: "SQLite", label: "SQLite", description: "Zero-config, embedded" },
              { value: "Mongo", label: "Mongo" },
            ],
          },
        ],
      });
      const answers = await new Promise<Record<string, string>>((resolve) => {
        this.pendingQuestions.set(requestId, resolve);
      });
      const chosen = Object.values(answers)[0] ?? "nothing (skipped)";
      emit({ kind: "tool", name: "note", detail: `You chose ${chosen}` });
    }

    // Plan mode ends by presenting the plan for approval — the demo's
    // way to exercise the parked-turn behaviour without a real agent.
    if (request.mode === "plan") {
      await delay(200);
      const requestId = `demo-plan-${this.planSeq++}`;
      emit({
        kind: "permission",
        requestId,
        title: "Ready to code?",
        isPlan: true,
        planMarkdown:
          "# Plan\n\n1. Add the port\n2. Wire the adapter\n3. Cover it with tests",
        options: [
          {
            optionId: "acceptEdits",
            name: "Yes, auto-accept edits",
            kind: "allow_always",
          },
          { optionId: "default", name: "Yes, approve each edit", kind: "allow_once" },
          { optionId: "plan", name: "No, keep planning", kind: "reject_once" },
        ],
      });
      const choice = await new Promise<string>((resolve) => {
        this.pendingPermissions.set(requestId, resolve);
      });
      if (choice === "plan") return; // declined: the turn is over
      emit({ kind: "tool", name: "note", detail: "Plan approved — starting work." });
    }

    if (wantsPermission && request.permission !== "bypass") {
      await delay(200);
      const requestId = `demo-${Date.now()}`;
      emit({
        kind: "permission",
        requestId,
        title: "Run npm test",
        options: [
          { optionId: "allow", name: "Allow Once", kind: "allow_once" },
          { optionId: "reject", name: "Deny", kind: "reject_once" },
        ],
      });
      const choice = await new Promise<string>((resolve) => {
        this.pendingPermissions.set(requestId, resolve);
      });
      emit({
        kind: "tool",
        name: "shell",
        detail: choice === "allow" ? "npm test ✓" : "npm test (denied)",
      });
    }

    const reply =
      "Here's what I found:\n\n" +
      "| File | Status |\n|---|---|\n| `src/main.ts` | ok |\n\n" +
      "- The setup looks **good**\n- I adjusted one detail\n\n" +
      '```ts\nconsole.log("done");\n```';
    for (const chunk of reply.match(/.{1,14}/gs) ?? []) {
      await delay(35);
      emit({ kind: "assistantDelta", text: chunk });
    }
    await delay(120);
    emit({ kind: "usage", used: 41_000, size: 200_000 });
    emit({ kind: "completed", isError: false, providerSessionId: "demo-session" });
  }

  async cancelTurn(tabId: string): Promise<void> {
    this.cancelled.add(tabId);
  }

  async respondPermission(_tabId: string, requestId: string, optionId: string) {
    this.pendingPermissions.get(requestId)?.(optionId);
    this.pendingPermissions.delete(requestId);
  }

  async respondQuestion(
    _tabId: string,
    requestId: string,
    answers: Readonly<Record<string, string>>,
  ) {
    this.pendingQuestions.get(requestId)?.({ ...answers });
    this.pendingQuestions.delete(requestId);
  }

  async endSession(): Promise<void> {}
  async warmSession(): Promise<void> {}
  async listNativeSessions(): Promise<{ sessionId: string }[] | null> {
    return null; // demo: no live agent, so no native history to ask
  }
  async loadNativeSession(): Promise<{ replayed: boolean }> {
    return { replayed: true };
  }
}

export class DemoWorkspaceStore implements WorkspaceStore {
  private workspace: PersistedWorkspace | null = null;
  async load() {
    return this.workspace;
  }
  async save(workspace: PersistedWorkspace) {
    this.workspace = workspace;
  }
}

export class DemoFolderPicker implements FolderPicker {
  private count = 0;
  async pickFolder(): Promise<string | null> {
    this.count += 1;
    return `/demo/project-${this.count}`;
  }
}

export class DemoFilePicker implements FilePicker {
  async pickFiles(): Promise<string[]> {
    return ["/demo/docs/spec.pdf"];
  }
}

export class DemoPastedImageStore implements PastedImageStore {
  async saveImage(): Promise<string> {
    return "/demo/pasted/screenshot.png";
  }
}

export class DemoCommandCatalog implements CommandCatalog {
  async listCustomCommands(): Promise<CommandInfo[]> {
    return [{ name: "/deploy", description: "Ship it to production", source: "project" }];
  }
}

export class DemoGit implements GitPort {
  private staged = new Set(["src/core/state/appState.ts"]);
  private unstaged = new Set(["src/ui/App.tsx", "README.md"]);

  async changes(): Promise<GitChange[]> {
    return [
      ...[...this.staged].map((path) => ({
        path,
        staged: true,
        unstaged: false,
        label: "modified",
      })),
      ...[...this.unstaged].map((path) => ({
        path,
        staged: false,
        unstaged: true,
        label: path === "README.md" ? "untracked" : "modified",
      })),
    ];
  }
  async log(): Promise<GitCommit[]> {
    return [
      {
        hash: "a1b2c3d",
        subject: "Add plan side panel",
        author: "mota",
        when: "2 hours ago",
      },
      {
        hash: "d4e5f6a",
        subject: "Fix approval race",
        author: "mota",
        when: "5 hours ago",
      },
    ];
  }
  async branches(): Promise<GitBranch[]> {
    return [
      { name: "main", current: true },
      { name: "feature/polish", current: false },
    ];
  }
  async remoteUrl(): Promise<string> {
    return "git@github.com:mota/mota-editor.git";
  }
  async listFiles(): Promise<string[]> {
    return [
      "README.md",
      "docs/ARCHITECTURE.md",
      "src/ui/App.tsx",
      "src/ui/components/Composer.tsx",
      "src/core/entities/fileMention.ts",
      "src/core/state/appState.ts",
      "src-tauri/src/git.rs",
    ];
  }
  async diff(_p: string, path: string): Promise<string> {
    return [
      `diff --git a/${path} b/${path}`,
      "index 1111111..2222222 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,4 +1,4 @@",
      " const before = true;",
      "-const changed = 1;",
      "+const changed = 2;",
      " const after = true;",
    ].join("\n");
  }
  async stage(_p: string, path: string) {
    this.unstaged.delete(path);
    this.staged.add(path);
  }
  async unstage(_p: string, path: string) {
    this.staged.delete(path);
    this.unstaged.add(path);
  }
  async commit(): Promise<string> {
    this.staged.clear();
    return "1 file changed";
  }
  async checkout(_p: string, branch: string): Promise<string> {
    return `Switched to branch '${branch}'`;
  }
  async push(): Promise<string> {
    return "Everything up-to-date";
  }
  async pull(): Promise<string> {
    return "Already up to date.";
  }
  async fetch(): Promise<string> {
    return "Fetched origin.";
  }
}

export class DemoTranscriptStore implements TranscriptStore {
  private transcripts = new Map<string, PersistedTranscript>();
  async save(_p: string, transcript: PersistedTranscript) {
    this.transcripts.set(transcript.id, transcript);
  }
  async list(): Promise<TranscriptMeta[]> {
    return [...this.transcripts.values()]
      .map((t) => ({
        id: t.id,
        title: t.title,
        savedAt: t.savedAt,
        provider: t.provider,
        messageCount: t.messages.length,
      }))
      .sort((a, b) => b.savedAt - a.savedAt);
  }
  async load(_p: string, id: string) {
    return this.transcripts.get(id) ?? null;
  }
  async remove(_p: string, id: string) {
    this.transcripts.delete(id);
  }
  async readPlanFile(_projectPath: string, _path: string): Promise<string | null> {
    return "# Demo plan\n\n1. Step one\n2. Step two";
  }
  async listStats(): Promise<SessionStats[]> {
    // A small synthetic spread so the Insights section renders populated
    // charts in the browser demo.
    const day = 86_400_000;
    const now = Date.now();
    const turn = (
      daysAgo: number,
      tokens: number,
      extra: Partial<TurnStat> = {},
    ): TurnStat => ({
      sentAt: now - daysAgo * day,
      mode: "normal",
      permission: "default",
      durationMs: 45_000 + tokens,
      tokens,
      toolCounts: { read: 3, edit: 1, execute: 1 },
      ...extra,
    });
    return [
      {
        sessionId: "demo-1",
        // Matches DemoBillingStore, so this one shows EXACT cost.
        providerSessionId: "demo-provider-1",
        title: "Refactor the settings panel",
        projectPath: "/demo/project",
        projectDirHash: "demo1",
        provider: "claude",
        savedAt: now,
        turns: [
          turn(6, 12_000, { mode: "plan" }),
          turn(3, 24_000, { command: "/review" }),
          turn(1, 18_000, { model: "sonnet" }),
          turn(0, 9_000, { stopReason: "cancelled" }),
        ],
        touchedFiles: { "src/app.ts": 5, "src/ui/view.tsx": 2 },
      },
      {
        // No provider session id: the estimate path, so the demo also
        // shows the mixed-provenance "≈" marker the real app relies on.
        sessionId: "demo-2",
        title: "Debug the flaky test",
        projectPath: "/demo/other",
        projectDirHash: "demo2",
        provider: "codex",
        savedAt: now - day,
        turns: [
          turn(4, 15_000, { command: "/commit" }),
          turn(2, 7_000, { effort: "high" }),
        ],
        touchedFiles: { "src/queue.ts": 3 },
      },
    ];
  }
}

/**
 * Browser demo — one session's worth of billed usage, shaped like a real
 * conversation: a big first cache write, then mostly cache reads.
 *
 * Timestamps land just after DemoTranscriptStore's turns on purpose. The
 * report credits each request to the turn that was running when it was
 * made, so a demo whose requests drifted away from its turns would show
 * commands costing nothing.
 */
export class DemoBillingStore implements BillingStore {
  async readBilledUsage(sessionIds: readonly string[]): Promise<BilledRequest[]> {
    if (!sessionIds.includes("demo-provider-1")) return [];
    const day = 86_400_000;
    const minute = 60_000;
    const now = Date.now();
    /** `daysAgo` mirrors a turn in DemoTranscriptStore.listStats. */
    const request = (
      id: string,
      daysAgo: number,
      patch: Partial<BilledRequest> = {},
    ): BilledRequest => ({
      requestId: `demo-req-${id}`,
      sessionId: "demo-provider-1",
      timestampMs: now - daysAgo * day + minute,
      model: "claude-opus-5",
      isSidechain: false,
      inputTokens: 120,
      outputTokens: 1_400,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 48_000,
      ...patch,
    });
    return [
      // The cold start: nothing cached yet, so the whole prefix is written.
      request("a", 6, { cacheWrite1hTokens: 32_000, cacheReadTokens: 0 }),
      // Two requests and a subagent inside the /review turn.
      request("b", 3),
      request("c", 3, { cacheWrite5mTokens: 6_500 }),
      request("d", 3, { isSidechain: true, model: "claude-haiku-4-5-20251001" }),
      request("e", 1),
    ];
  }
}

export class DemoNotifications implements NotificationPort {
  async turnCompleted(): Promise<void> {}
}

/** Browser demo — a plausible inventory so the Tools screen has numbers. */
export class DemoMcpProbe implements McpProbe {
  async probe(server: McpServerSpec): Promise<McpProbeResult> {
    await delay(400);
    if (server.command === "broken") return { error: "`broken` is not on your PATH." };
    return { inventory: { toolCount: 12, prefixTokens: 3_400 } };
  }
}

/** Claude answers; the others show the two failure states worth seeing. */
export class DemoProviderProbe implements ProviderProbe {
  async probe(provider: ProviderId): Promise<ProviderStatus> {
    await delay(400);
    if (provider === "claude") {
      return {
        provider,
        installed: true,
        authenticated: true,
        detail: "Connected via demo-agent.",
        installHint: "",
      };
    }
    if (provider === "codex") {
      return {
        provider,
        installed: true,
        authenticated: false,
        detail: "Not signed in. Sign in to the codex CLI in a terminal first.",
        installHint: "npm i -g @agentclientprotocol/codex-acp",
      };
    }
    return {
      provider,
      installed: false,
      authenticated: false,
      detail: "no launch candidate found on PATH",
      installHint: "npm i -g @google/gemini-cli",
    };
  }
}
