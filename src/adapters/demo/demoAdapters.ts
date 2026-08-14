import type { AppBadge } from "../../core/entities/appBadge";
import type { BilledRequest } from "../../core/entities/billing";
import type { CommandInfo } from "../../core/entities/command";
import type { ExtensionDescriptor } from "../../core/entities/extension";
import type { SessionStats, TurnStat } from "../../core/entities/insights";
import type { McpServerSpec } from "../../core/entities/mcpServer";
import type { ProviderId } from "../../core/entities/provider";
import type { ProvisionEntry } from "../../core/entities/worktree";
import type {
  AgentGateway,
  AgentTurnEvent,
  AgentTurnRequest,
} from "../../core/ports/agentGateway";
import type { AppBadgePort } from "../../core/ports/appBadgePort";
import type { BillingStore } from "../../core/ports/billingStore";
import type { CommandCatalog } from "../../core/ports/commandCatalog";
import type {
  ExtensionHostEvent,
  ExtensionHostPort,
} from "../../core/ports/extensionHost";
import type {
  GitBranch,
  GitChange,
  GitCommit,
  GitDivergence,
  GitPort,
  GitWorktree,
  WorktreeAddMode,
  WorktreeRemoveMode,
} from "../../core/ports/gitPort";
import type { McpProbe, McpProbeResult } from "../../core/ports/mcpProbe";
import type { NotificationPort } from "../../core/ports/notificationPort";
import type { ProviderProbe, ProviderStatus } from "../../core/ports/providerProbe";
import type { ShellHistorySource } from "../../core/ports/shellHistorySource";
import type {
  ShellOpenRequest,
  ShellPort,
  ShellStream,
} from "../../core/ports/shellPort";
import type {
  PersistedTranscript,
  SessionKeywords,
  TranscriptMeta,
  TranscriptStore,
} from "../../core/ports/transcriptStore";
import type { WindowPort } from "../../core/ports/windowPort";
import type {
  FilePicker,
  FolderPicker,
  PastedImageStore,
  PersistedWorkspace,
  WorkspaceStore,
} from "../../core/ports/workspacePort";
import type {
  DiskUsage,
  ProvisionReport,
  WorktreeProvisioning,
} from "../../core/ports/worktreeProvisioning";
import type { ZoomPort } from "../../core/ports/zoomPort";

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

  // Nothing here schedules anything, so the demo agent never comes
  // back on its own. The real gateway is where this lane matters.
  subscribeAgentInitiated(): void {}

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
    // Ask reads and answers. A demo agent that offered to run the tests
    // would be showing behaviour the real one is sandboxed out of.
    const readOnly = request.mode === "ask";
    const wantsPermission =
      !readOnly && /\b(run|delete|install|deploy)\b/i.test(request.prompt);
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

    const reply = readOnly
      ? "Here's what I found:\n\n" +
        "| File | Role |\n|---|---|\n| `src/main.ts` | reads the config, then boots |\n\n" +
        "- Nothing was changed — this is **Ask** mode\n\n" +
        '```ts\nconsole.log("done");\n```'
      : "Here's what I found:\n\n" +
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
  async currentBranch(): Promise<string> {
    return "main";
  }
  async upstream(): Promise<GitDivergence> {
    return { behind: 1, ahead: 2 };
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
  async stageAll() {
    for (const path of this.unstaged) this.staged.add(path);
    this.unstaged.clear();
  }
  async unstageAll() {
    for (const path of this.staged) this.unstaged.add(path);
    this.staged.clear();
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

  // Linked worktrees only — the main entry is derived per call, echoing
  // whichever demo folder asks, so plain demo tabs never look like
  // worktrees. `worktreeOrigins` maps a linked worktree back to its main.
  private readonly worktreeList: GitWorktree[] = [
    {
      path: "/demo/mota-editor-worktrees/feature-polish",
      branch: "feature/polish",
      head: "d4e5f6a",
      main: false,
      bare: false,
      locked: false,
      prunable: false,
    },
  ];
  private readonly worktreeOrigins = new Map<string, string>([
    ["/demo/mota-editor-worktrees/feature-polish", "/demo/mota-editor"],
  ]);

  async worktrees(projectPath: string): Promise<GitWorktree[]> {
    const main = this.worktreeOrigins.get(projectPath) ?? projectPath;
    return [
      {
        path: main,
        branch: "main",
        head: "a1b2c3d",
        main: true,
        bare: false,
        locked: false,
        prunable: false,
      },
      ...this.worktreeList,
    ];
  }

  async worktreeAdd(
    projectPath: string,
    worktreePath: string,
    branch: string,
    _mode: WorktreeAddMode,
    _remote: string,
    _base: string,
  ): Promise<string> {
    this.worktreeList.push({
      path: worktreePath,
      branch,
      head: "a1b2c3d",
      main: false,
      bare: false,
      locked: false,
      prunable: false,
    });
    this.worktreeOrigins.set(
      worktreePath,
      this.worktreeOrigins.get(projectPath) ?? projectPath,
    );
    return `Preparing worktree (checking out '${branch}')`;
  }

  async worktreeRemove(
    _projectPath: string,
    worktreePath: string,
    _mode: WorktreeRemoveMode,
  ): Promise<string> {
    const at = this.worktreeList.findIndex((w) => w.path === worktreePath);
    if (at !== -1) this.worktreeList.splice(at, 1);
    this.worktreeOrigins.delete(worktreePath);
    return `Removing worktree ${worktreePath}`;
  }

  async worktreePrune(): Promise<string> {
    return "";
  }

  async branchesMerged(): Promise<GitBranch[]> {
    return [{ name: "dev", current: false, remote: false }];
  }
}

/**
 * Provisioning without a disk: every folder reports as copied, and the
 * sizes are plausible constants so the UI has something to lay out.
 */
export class DemoWorktreeProvisioning implements WorktreeProvisioning {
  async provision(
    _mainPath: string,
    worktreePath: string,
    entries: readonly ProvisionEntry[],
  ): Promise<ProvisionReport> {
    await delay(600);
    return {
      worktreePath,
      entries: entries.map((entry) => ({
        path: entry.path,
        strategy: entry.strategy,
        outcome: entry.strategy === "share" ? "linked" : "copied",
        message: "",
      })),
      ok: true,
    };
  }

  async unprovision(_worktreePath: string, paths: readonly string[]) {
    return [...paths];
  }

  async supportsCow() {
    return true;
  }

  async folderCandidates() {
    return [
      "docs",
      "node_modules",
      "src",
      "src/core",
      "src/ui",
      "src-tauri",
      "src-tauri/target",
    ];
  }

  async diskUsage(): Promise<DiskUsage> {
    return {
      ownBytes: 2_100_000,
      sharedBytes: 5_140_000_000,
      apparentBytes: 5_142_100_000,
      entries: [
        { path: "src-tauri", bytes: 4_900_000_000, shared: true },
        { path: "node_modules", bytes: 240_000_000, shared: true },
        { path: "src", bytes: 2_000_000, shared: false },
      ],
      truncated: false,
    };
  }
}

export class DemoTranscriptStore implements TranscriptStore {
  private transcripts = new Map<string, PersistedTranscript>();
  /** Which folder each transcript belongs to. The real store keeps them
   *  in a per-project directory; history asks it about one checkout at a
   *  time, so a store that answered with all of them would make every
   *  session look like it happened everywhere. */
  private folders = new Map<string, string>();
  async save(projectPath: string, transcript: PersistedTranscript) {
    this.transcripts.set(transcript.id, transcript);
    this.folders.set(transcript.id, projectPath);
  }
  async list(projectPath: string): Promise<TranscriptMeta[]> {
    return [...this.transcripts.values()]
      .filter((t) => this.folders.get(t.id) === projectPath)
      .map((t) => ({
        id: t.id,
        title: t.title,
        savedAt: t.savedAt,
        provider: t.provider,
        messageCount: t.messages.length,
      }))
      .sort((a, b) => b.savedAt - a.savedAt);
  }
  async listExternal() {
    return []; // no vendor store exists in a browser
  }
  /**
   * A deliberately naive stand-in for the real extraction, which is
   * Rust's (`agent_core::session_keywords`) and reads files this build
   * has none of: the longest handful of distinct words. Enough for the
   * browser demo to show keyword search working, and not worth a second
   * copy of the ranking rules to do better.
   */
  async keywords(projectPath: string): Promise<SessionKeywords[]> {
    return [...this.transcripts.values()]
      .filter((t) => this.folders.get(t.id) === projectPath)
      .map((t) => ({
        id: t.id,
        keywords: [
          ...new Set(
            `${t.title} ${t.messages.map((m) => m.text).join(" ")}`
              .toLowerCase()
              .split(/[^\p{L}\p{N}]+/u)
              .filter((word) => word.length > 3),
          ),
        ].slice(0, 40),
      }));
  }
  async load(_p: string, id: string) {
    return this.transcripts.get(id) ?? null;
  }
  async remove(_p: string, id: string) {
    this.transcripts.delete(id);
    this.folders.delete(id);
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
      {
        // A conversation that ran long, so the growth curve has a shape
        // to show: each turn re-sends the ones before it, so the cost
        // climbs with depth. Without this the demo's Growth section is a
        // single bar, which is exactly the story it exists to disprove.
        sessionId: "demo-3",
        title: "Port the importer to the new API",
        projectPath: "/demo/project",
        projectDirHash: "demo1",
        provider: "claude",
        savedAt: now - 2 * day,
        turns: Array.from({ length: 38 }, (_, i) =>
          turn(
            5 - (i * 4) / 38,
            9_000 + i * 1_800,
            i === 12 ? { command: "/review" } : {},
          ),
        ),
        touchedFiles: { "src/importer.ts": 14, "src/api/client.ts": 6 },
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
  async show(): Promise<void> {}
}

/**
 * Browser demo — two canned extensions: one enabled and contributing a
 * command in both flavors, one awaiting approval with a dangerous
 * permission, so the settings screen, consent flow and command routing
 * are all exercisable without the Rust host.
 */
export class DemoExtensionHost implements ExtensionHostPort {
  private listeners: ((extensionId: string, event: ExtensionHostEvent) => void)[] = [];
  private demoTaskStatus = new Map<string, string>([
    ["task-1", "started"],
    ["task-2", "todo"],
    ["task-3", "todo"],
  ]);
  private demoTasks: { id: string; key: string; title: string; badge?: string }[] = [
    ...DEMO_TASKS,
  ];
  private extensions: ExtensionDescriptor[] = [
    {
      id: "demo-tracker",
      displayName: "Tracker (demo)",
      version: "0.1.0",
      description: "Your issues in the sidebar, grouped by status.",
      origin: "user",
      path: "~/.mota/extensions/demo-tracker",
      permissions: ["ui:panel"],
      status: "enabled",
      commands: [],
      mcpServers: [],
      panels: [{ id: "tasks", title: "Tracker", icon: "checklist" }],
      events: [],
    },
    {
      id: "demo-standup",
      displayName: "Standup (demo)",
      version: "0.1.0",
      description: "Drafts a standup update from your recent sessions.",
      origin: "user",
      path: "~/.mota/extensions/demo-standup",
      permissions: ["commands:register", "notifications"],
      status: "enabled",
      commands: [
        {
          name: "standup",
          description: "Draft a standup update",
          argsHint: "[days]",
          kind: "prompt",
          template: "Summarize the last $ARGUMENTS days of work as a standup update.",
        },
        {
          name: "standup-notify",
          description: "Ping me when the draft is ready",
          kind: "programmatic",
        },
      ],
      mcpServers: [],
      panels: [],
      events: [],
    },
    {
      id: "demo-deployer",
      displayName: "Deployer (demo)",
      version: "0.3.0",
      description: "Runs your deploy script after a turn completes.",
      origin: "project",
      projectPath: "/demo/project",
      path: "/demo/project/.mota/extensions/demo-deployer",
      permissions: ["events:subscribe", "shell:exec", "notifications"],
      status: "needs-approval",
      commands: [],
      mcpServers: [],
      panels: [],
      events: ["turn/completed"],
    },
  ];

  subscribe(listener: (extensionId: string, event: ExtensionHostEvent) => void): void {
    this.listeners.push(listener);
  }

  private notify(extensionId: string, event: ExtensionHostEvent): void {
    for (const listener of this.listeners) listener(extensionId, event);
  }

  async list(): Promise<ExtensionDescriptor[]> {
    await delay(120);
    return [...this.extensions];
  }

  async enable(id: string): Promise<ExtensionDescriptor> {
    await delay(300); // stands in for the native consent dialog
    this.extensions = this.extensions.map((e) =>
      e.id === id ? { ...e, status: "enabled" as const } : e,
    );
    const enabled = this.extensions.find((e) => e.id === id);
    if (!enabled) throw new Error(`Unknown extension: ${id}`);
    this.notify(id, { kind: "statusChanged", status: "enabled" });
    return enabled;
  }

  async disable(id: string): Promise<void> {
    this.extensions = this.extensions.map((e) =>
      e.id === id ? { ...e, status: "disabled" as const } : e,
    );
    this.notify(id, { kind: "statusChanged", status: "disabled" });
  }

  async invokeCommand(extensionId: string, command: string): Promise<unknown> {
    await delay(250);
    return {
      actions: [
        {
          type: "notify",
          title: "Standup (demo)",
          message: `Command /${command} ran in ${extensionId}.`,
        },
        { type: "insertPrompt", text: "Here is the standup draft the extension built." },
      ],
    };
  }

  async loadPanel(): Promise<unknown> {
    await delay(200);
    return { view: this.demoTaskView() };
  }

  async panelAction(
    _extensionId: string,
    _panelId: string,
    request: { action: string; itemId: string; value?: string },
  ): Promise<unknown> {
    await delay(150);
    if (request.action === "select" && request.value) {
      this.demoTaskStatus.set(request.itemId, request.value);
      return { view: this.demoTaskView() };
    }
    if (request.action === "submit" && request.value) {
      const id = `task-${this.demoTasks.length + 1}`;
      this.demoTasks.push({
        id,
        key: `DEM-${42 + this.demoTasks.length}`,
        title: request.value,
      });
      this.demoTaskStatus.set(id, "todo");
      return { view: this.demoTaskView() };
    }
    if (request.action === "open") {
      return {
        detail: {
          title:
            this.demoTasks.find((t) => t.id === request.itemId)?.title ?? request.itemId,
          subtitle: "DEM-42 · Demo project",
          fields: [
            { label: "Priority", value: "High" },
            { label: "Assignee", value: "You" },
          ],
          body: "A canned task so the browser demo can exercise the panel modal.\n\nThe real thing comes from an extension process over MXP.",
          url: "https://example.com/DEM-42",
        },
      };
    }
    return {};
  }

  private demoTaskView(): unknown {
    const options = [
      { id: "todo", label: "Todo" },
      { id: "started", label: "In Progress" },
      { id: "done", label: "Done" },
    ];
    const byStatus = (status: string) =>
      this.demoTasks
        .filter((task) => this.demoTaskStatus.get(task.id) === status)
        .map((task) => ({
          id: task.id,
          title: task.title,
          subtitle: task.key,
          badge: task.badge,
          select: { options, selectedId: status },
        }));
    return {
      input: { id: "new-task", placeholder: "Add a task…" },
      groups: [
        { title: "In Progress", items: byStatus("started") },
        { title: "Todo", items: byStatus("todo") },
        { title: "Done", items: byStatus("done") },
      ].filter((group) => group.items.length > 0),
    };
  }

  async publishEvent(): Promise<void> {}

  async respond(): Promise<void> {}

  async readLog(): Promise<string> {
    return "[log] demo extension started\n[log] nothing else to report";
  }
}

const DEMO_TASKS = [
  { id: "task-1", key: "DEM-42", title: "Wire the demo panel", badge: "High" },
  { id: "task-2", key: "DEM-43", title: "Group tasks by status" },
  { id: "task-3", key: "DEM-44", title: "Open a detail modal", badge: "Low" },
];

/**
 * Browser demo — a history with a clear favourite, so the greyed-out
 * suggestion has something to show and its ranking is visible.
 */
export class DemoShellHistory implements ShellHistorySource {
  async recent(): Promise<readonly string[]> {
    await delay(80);
    return ["git status", "npm run build", "npm test", "npm test", "npm test", "help"];
  }
}

/**
 * Browser demo — a shell that cannot run anything, but answers. Enough
 * to drive the panel end to end (echo, prompt, exit, close) without a
 * pty, so the port stays honest outside Tauri.
 */
export class DemoShell implements ShellPort {
  private readonly streams = new Map<string, ShellStream>();
  private readonly lines = new Map<string, string>();
  private readonly prompts = new Map<string, string>();
  private readonly escaping = new Set<string>();
  private nextId = 1;

  async open(request: ShellOpenRequest, stream: ShellStream): Promise<string> {
    const sessionId = `demo-shell-${this.nextId++}`;
    this.streams.set(sessionId, stream);
    this.lines.set(sessionId, "");
    this.prompts.set(sessionId, `\x1b[36m${request.cwd || "demo"}\x1b[0m $ `);
    await delay(120);
    this.say(
      sessionId,
      "Browser preview — this terminal is a stand-in and runs nothing.\r\n" +
        "Run \x1b[1mnpm run tauri dev\x1b[0m for a real shell.\r\n\r\n",
    );
    this.prompt(sessionId);
    return sessionId;
  }

  async write(sessionId: string, data: string): Promise<void> {
    for (const char of data) this.type(sessionId, char);
  }

  async resize(): Promise<void> {}

  async close(sessionId: string): Promise<void> {
    this.streams.delete(sessionId);
    this.lines.delete(sessionId);
    this.prompts.delete(sessionId);
    this.escaping.delete(sessionId);
  }

  async closeProject(): Promise<void> {}

  /** Line discipline, by hand: a pty would normally do the echoing. */
  private type(sessionId: string, char: string): void {
    const line = this.lines.get(sessionId);
    if (line === undefined) return;
    // Swallow escape sequences whole. A real terminal acts on an arrow
    // key; echoing its bytes would print "[C" at the prompt.
    if (this.escaping.has(sessionId)) {
      if (char >= "@" && char <= "~") this.escaping.delete(sessionId);
      return;
    }
    if (char === "") {
      this.escaping.add(sessionId);
      return;
    }
    if (char === "\r") {
      this.say(sessionId, "\r\n");
      this.run(sessionId, line.trim());
      return;
    }
    if (char === "\x7f" || char === "\b") {
      if (line.length === 0) return;
      this.lines.set(sessionId, line.slice(0, -1));
      this.say(sessionId, "\b \b");
      return;
    }
    if (char < " ") return; // control keys do nothing here
    this.lines.set(sessionId, line + char);
    this.say(sessionId, char);
  }

  private run(sessionId: string, command: string): void {
    this.lines.set(sessionId, "");
    if (command === "exit") {
      this.streams.get(sessionId)?.onExit(0);
      this.streams.delete(sessionId);
      return;
    }
    if (command === "clear") this.say(sessionId, "\x1b[2J\x1b[H");
    else if (command === "help")
      this.say(sessionId, "Known here: help, clear, exit. Nothing else runs.\r\n");
    else if (command !== "")
      this.say(sessionId, `${command}: not available in the browser preview\r\n`);
    this.prompt(sessionId);
  }

  private prompt(sessionId: string): void {
    this.say(sessionId, this.prompts.get(sessionId) ?? "$ ");
  }

  private say(sessionId: string, text: string): void {
    this.streams.get(sessionId)?.onOutput(new TextEncoder().encode(text));
  }
}

/** Browser demo — a plausible inventory so the Tools screen has numbers. */
export class DemoMcpProbe implements McpProbe {
  async probe(server: McpServerSpec): Promise<McpProbeResult> {
    await delay(400);
    if (server.command === "broken") return { error: "`broken` is not on your PATH." };
    return { inventory: { toolCount: 12, prefixTokens: 3_400 } };
  }
}

/** One provider per readiness state, so the settings screen can be seen
 * in every shape it has without three broken machines. */
export class DemoProviderProbe implements ProviderProbe {
  async probe(provider: ProviderId): Promise<ProviderStatus> {
    await delay(400);
    if (provider === "claude") {
      return {
        provider,
        readiness: "started",
        detail: "Started via demo-agent. Sign-in is confirmed on the first message.",
        installHint: "",
        signInCommand: "claude auth login",
      };
    }
    if (provider === "codex") {
      return {
        provider,
        readiness: "signInRequired",
        detail:
          "Failed to authenticate: OAuth session expired and could not be refreshed",
        installHint: "npm i -g @agentclientprotocol/codex-acp",
        signInCommand: "codex login",
      };
    }
    return {
      provider,
      readiness: "notInstalled",
      detail: "no launch candidate found on PATH",
      installHint: "npm i -g @google/gemini-cli",
      signInCommand: "gemini",
    };
  }

  async signIn(): Promise<void> {
    await delay(200);
  }
}

/**
 * Zoom without a webview: CSS `zoom` on the document, which the browser
 * this demo runs in understands. Close enough to see the effect; the
 * real app scales the webview itself.
 */
export class DemoZoom implements ZoomPort {
  async apply(factor: number): Promise<void> {
    document.documentElement.style.zoom = String(factor);
  }
}

/**
 * A browser tab's close is the browser's to grant, not ours: the page
 * gets `beforeunload` and a generic dialog it cannot word, and nothing
 * else. So the preview simply lets the tab go — there is no real agent
 * turn behind it to lose.
 */
export class DemoWindow implements WindowPort {
  onCloseRequested(): void {}
  async close(): Promise<void> {}
}

/**
 * A browser tab has no taskbar icon to decorate, so the badge goes where
 * a browser does show it: the document title, the way a webmail counts
 * unread messages. Enough to see the rule working in the preview.
 */
export class DemoAppBadge implements AppBadgePort {
  private readonly base = document.title;

  async show(badge: AppBadge | null): Promise<void> {
    document.title = badge === null ? this.base : `(${badge.count}) ${this.base}`;
  }
}
