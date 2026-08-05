import type { CommandInfo } from "../../core/entities/command";
import type { ProviderId } from "../../core/entities/provider";
import type {
  AgentGateway,
  AgentTurnEvent,
  AgentTurnRequest,
} from "../../core/ports/agentGateway";
import type { CommandCatalog } from "../../core/ports/commandCatalog";
import type { GitBranch, GitChange, GitCommit, GitPort } from "../../core/ports/gitPort";
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

  async startTurn(
    request: AgentTurnRequest,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void> {
    this.cancelled.delete(request.tabId);
    void this.run(request, onEvent);
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

    const wantsPlan = /\bplan\b/i.test(request.prompt) || request.mode === "plan";
    const wantsPermission = /\b(run|delete|install|deploy)\b/i.test(request.prompt);

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

  async endSession(): Promise<void> {}
  async warmSession(): Promise<void> {}
  async listNativeSessions(): Promise<{ sessionId: string }[]> {
    throw new Error("demo: no native history");
  }
  async loadNativeSession(): Promise<void> {}
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

export class DemoCommandCatalog implements CommandCatalog {
  async listCustomCommands(): Promise<CommandInfo[]> {
    return [{ name: "/deploy", description: "Ship it to production", source: "custom" }];
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
}

export class DemoNotifications implements NotificationPort {
  async turnCompleted(): Promise<void> {}
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
