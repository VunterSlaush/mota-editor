import type {
  AgentMode,
  AutoCompactPolicy,
  PermissionPolicy,
} from "../entities/agentSettings";
import {
  DEFAULT_AUTO_COMPACT_THRESHOLD,
  DEFAULT_MODE,
  DEFAULT_PERMISSION,
} from "../entities/agentSettings";
import type { CommandInfo } from "../entities/command";
import type { CommandConfig } from "../entities/commandConfig";
import type { McpServerConfig } from "../entities/mcpServer";
import type {
  ChatMessage,
  MessageRole,
  ToolCallContent,
  ToolLocation,
} from "../entities/message";
import { mergeToolCall } from "../entities/message";
import type { PlanEntry } from "../entities/plan";
import type { Project, ProjectDefaults } from "../entities/project";
import { normalizedTabLabel } from "../entities/project";
import type { ProviderId } from "../entities/provider";
import {
  contextWindowFor,
  DEFAULT_PROVIDER,
  isProvisionalContextSize,
} from "../entities/provider";
import type { ShellSession } from "../entities/shellSession";
import { shellAfterClosing } from "../entities/shellSession";
import type { TabColorId } from "../entities/tabColor";
import type { ProvisionEntry, WorktreeSettings } from "../entities/worktree";
import { defaultWorktreeSettings } from "../entities/worktree";
import { DEFAULT_ZOOM_LEVEL } from "../entities/zoom";

/**
 * Core state — a pure, framework-free model of the whole workbench,
 * evolved exclusively through the reducer below. The UI renders it;
 * use cases dispatch actions against it. No React, no Tauri in here.
 */

/** A prompt written while the agent was busy, waiting for its turn. */
export interface QueuedPrompt {
  readonly prompt: string;
  readonly attachments: readonly string[];
}

export interface TabState {
  readonly project: Project;
  readonly messages: readonly ChatMessage[];
  readonly busy: boolean;
  /** When the running turn started, for the elapsed counter. */
  readonly turnStartedAt?: number;
  /** The half-written prompt. Lives here, not in the composer, because
   *  switching tabs remounts the view and would otherwise bin it. */
  readonly draft?: string;
  readonly draftAttachments?: readonly string[];
  /** Prompts sent while busy — delivered in order as turns complete. */
  readonly queued: readonly QueuedPrompt[];
  /** Commands the running agent advertised (source of truth when set). */
  readonly agentCommands: readonly CommandInfo[];
  /** The agent's current plan; replaced wholesale on every update. */
  readonly plan: readonly PlanEntry[];
  /** Plan-mode plan text (from the plan-approval request), when any. */
  readonly planMarkdown?: string;
  /** Where the agent saved the plan on disk, when it did. */
  readonly planFilePath?: string;
  /** Id of the persisted transcript this conversation writes to. */
  readonly historySessionId?: string;
  /**
   * The transcript this tab was writing to when the app last closed —
   * a CLAIM, not a fact, because the messages are gone from the screen.
   * It becomes `historySessionId` again only if the agent turns out to
   * still be in that same conversation (the frontend reloaded but the
   * backend session survived, which is every hot reload in dev).
   * Otherwise the next prompt starts a new one, as it should: a fresh
   * agent session is a fresh chat.
   */
  readonly restoredHistorySessionId?: string;
  /** True when a turn finished while the user was on another tab. */
  readonly attention?: boolean;
  /** Set while this worktree's heavy folders are being put in place. */
  readonly preparing?: boolean;
  /** What went wrong preparing them, once, until dismissed. */
  readonly preparingProblem?: string;
  /** Context-window usage of the tab's agent session. `estimated` marks
   *  a client-side approximation (no `usage_update` from the agent);
   *  `provisional` marks an agent report whose `size` is the adapter's
   *  known placeholder, corrected when the first turn completes — the
   *  `used` figure is real either way. */
  readonly usage?: {
    readonly used: number;
    readonly size: number;
    readonly estimated?: boolean;
    readonly provisional?: boolean;
  };
  /**
   * A model/effort change the user made mid-conversation, held back
   * rather than applied.
   *
   * Applying either one respawns the tab's agent (both are spawn-time,
   * env-based over ACP), and the respawned agent re-sends the whole
   * conversation — at cache-WRITE rates for a model change, since the
   * prompt cache is keyed per model. Deferring to the next chat makes
   * that cost zero. Lives on the tab, not the Project, deliberately: it
   * is transient, and restoring it into a stale session would apply a
   * change to a conversation that no longer exists.
   *
   * `""` means the provider default, matching the pickers' sentinel.
   */
  readonly pendingSpec?: {
    readonly model?: string;
    readonly effort?: string;
  };
  /**
   * How full the context was when it crossed the auto-compact ceiling
   * under the "ask" policy, as a percentage. Present means the user owes
   * a decision — compact (a full pass over the context) or start a new
   * chat (free). Absent under every other policy.
   */
  readonly contextFullPercent?: number;
  /** Where session startup stands (installing|booting|creating|recovering);
   *  undefined once ready or failed. */
  readonly sessionStage?: string;
  /** The project's current git branch, cached from the last git read —
   *  tooltips read this instead of asking git on every hover. */
  readonly branch?: string;
  /**
   * The terminals open in this project.
   *
   * Here rather than in the panel's own React state because switching
   * projects remounts the view, and a remount must not silently kill a
   * running build. Only the lifecycle lives here: a terminal's *output*
   * never touches the store, or every frame of a build log would
   * re-render the app.
   */
  readonly shells: readonly ShellSession[];
  readonly activeShellId?: string;
  /**
   * A "!" line from the composer that had no free terminal to run in —
   * either this project has none open, or a build is holding every one
   * of them. Kept so the next terminal to open runs it, and so the
   * panel knows to open one: the alternative is a command that
   * disappears because a dev server happened to own the only shell.
   */
  readonly pendingShellLine?: string;
}

/**
 * App-wide preferences, persisted with the workspace. These seed every
 * NEW project tab; changing them never disturbs a tab already open.
 */
export interface AppSettings {
  readonly defaultProvider: ProviderId;
  readonly defaultMode: AgentMode;
  readonly defaultPermission: PermissionPolicy;
  /** Per provider — "sonnet" means nothing to Gemini. */
  readonly defaultModel: Readonly<Partial<Record<ProviderId, string>>>;
  readonly defaultEffort: Readonly<Partial<Record<ProviderId, string>>>;
  /** Settings a slash command applies to its tab, by `commandConfigKey`. */
  readonly commandConfigs: Readonly<Record<string, CommandConfig>>;
  /** MCP servers Mota hands to agents, per provider enablement. */
  readonly mcpServers: readonly McpServerConfig[];
  /** Fraction of the context window at which sessions auto-compact. */
  readonly autoCompactThreshold: number;
  /**
   * What happens when a session reaches that ceiling.
   *
   * Compaction is not free: it costs a full pass over the context plus a
   * cache re-write on the next turn. Starting a new chat costs nothing at
   * all. "ask" exists because which of those is right depends on whether
   * the conversation still matters — a question only the user can answer.
   */
  readonly autoCompact: AutoCompactPolicy;
  /** Color theme id, from `entities/theme`. */
  readonly theme: string;
  /** How far the interface is zoomed, in notches. 0 is untouched. */
  readonly zoomLevel: number;
  /** Where worktrees go, how they are stocked, what their tabs inherit. */
  readonly worktrees: WorktreeSettings;
  /**
   * The shell the terminal panel runs. A program path — `pwsh`, a Git
   * Bash `bash.exe`, `/bin/zsh` — never a command line. Empty means the
   * platform default (see `agent_core::shell`).
   */
  readonly terminalShell: string;
  readonly terminalFontSize: number;
  /** Greyed-out completions in the terminal, from the user's history. */
  readonly terminalSuggestions: boolean;
}

export interface AppState {
  readonly tabs: readonly TabState[];
  readonly activeTabId: string | null;
  readonly settings: AppSettings;
}

export const defaultSettings: AppSettings = {
  defaultProvider: DEFAULT_PROVIDER,
  defaultMode: DEFAULT_MODE,
  defaultPermission: DEFAULT_PERMISSION,
  defaultModel: {},
  defaultEffort: {},
  commandConfigs: {},
  mcpServers: [],
  autoCompactThreshold: DEFAULT_AUTO_COMPACT_THRESHOLD,
  autoCompact: "compact",
  theme: "mota-dark",
  zoomLevel: DEFAULT_ZOOM_LEVEL,
  worktrees: defaultWorktreeSettings,
  terminalShell: "",
  terminalFontSize: 13,
  terminalSuggestions: true,
};

export const initialState: AppState = {
  tabs: [],
  activeTabId: null,
  settings: defaultSettings,
};

export type Action =
  | {
      type: "workspace/restored";
      tabs: readonly TabState[];
      activeTabId: string | null;
      settings?: AppSettings;
    }
  | { type: "settings/changed"; patch: Partial<AppSettings> }
  | { type: "tab/opened"; project: Project }
  | { type: "tab/closed"; tabId: string }
  | { type: "worktree/preparing"; tabId: string }
  /** `problem` is absent when everything landed. */
  | { type: "worktree/prepared"; tabId: string; problem?: string }
  | { type: "tab/activated"; tabId: string }
  | { type: "tab/moved"; tabId: string; toIndex: number }
  | { type: "tab/attentionRequested"; tabId: string }
  | { type: "tab/providerChanged"; tabId: string; provider: ProviderId }
  | { type: "tab/modeChanged"; tabId: string; mode: AgentMode }
  | { type: "tab/permissionChanged"; tabId: string; permission: PermissionPolicy }
  | { type: "tab/modelChanged"; tabId: string; model: string }
  | { type: "tab/effortChanged"; tabId: string; effort: string }
  | { type: "tab/specDeferred"; tabId: string; model?: string; effort?: string }
  | { type: "tab/pendingSpecApplied"; tabId: string }
  | { type: "tab/pendingSpecDiscarded"; tabId: string }
  | { type: "tab/contextFullChanged"; tabId: string; percent: number | undefined }
  | {
      type: "tab/mcpOverrideChanged";
      tabId: string;
      serverId: string;
      /** undefined clears the override and follows the provider toggle. */
      enabled: boolean | undefined;
    }
  | {
      type: "tab/provisioningChanged";
      tabId: string;
      /** undefined clears the override and follows the app default. */
      provisioning: readonly ProvisionEntry[] | undefined;
    }
  | { type: "tab/verboseChanged"; tabId: string; verbose: boolean }
  | { type: "tab/labelChanged"; tabId: string; label: string }
  | { type: "tab/colorChanged"; tabId: string; color: TabColorId | undefined }
  | { type: "tab/commandsUpdated"; tabId: string; commands: readonly CommandInfo[] }
  | { type: "tab/planUpdated"; tabId: string; plan: readonly PlanEntry[] }
  | {
      type: "tab/planMarkdownUpdated";
      tabId: string;
      markdown: string;
      filePath?: string;
    }
  | {
      type: "tab/usageUpdated";
      tabId: string;
      used: number;
      size: number;
      estimated?: boolean;
    }
  | { type: "tab/sessionStageChanged"; tabId: string; stage: string | undefined }
  | { type: "tab/branchUpdated"; tabId: string; branch: string | undefined }
  /** The backend agent session was ended on purpose: forget everything
   *  tied to it (resume id, usage, advertised commands). */
  | { type: "chat/sessionReset"; tabId: string; provider: ProviderId }
  | { type: "chat/messageAppended"; tabId: string; message: ChatMessage }
  | {
      type: "chat/toolCallUpdated";
      tabId: string;
      toolCallId: string;
      patch: {
        readonly status?: string;
        readonly title?: string;
        readonly content?: readonly ToolCallContent[];
        readonly locations?: readonly ToolLocation[];
      };
    }
  | { type: "chat/assistantDelta"; tabId: string; text: string }
  | { type: "chat/userDelta"; tabId: string; text: string }
  | { type: "chat/thoughtDelta"; tabId: string; text: string }
  | { type: "chat/historySessionAssigned"; tabId: string; sessionId: string }
  /** A turn finished: stamp its outcome onto the prompt that started it. */
  | {
      type: "chat/turnMetaCompleted";
      tabId: string;
      messageId: string;
      patch: {
        readonly durationMs: number;
        readonly tokens?: number;
        readonly tokensEstimated?: boolean;
        readonly stopReason?: string;
      };
    }
  | {
      type: "chat/transcriptLoaded";
      tabId: string;
      sessionId: string;
      messages: readonly ChatMessage[];
      plan?: readonly PlanEntry[];
      planMarkdown?: string;
      /** The agent's own id for it, when the load attached to one — the
       *  tab is on that conversation from here on. */
      providerSessionId?: string;
    }
  | { type: "chat/cleared"; tabId: string }
  | { type: "chat/approvalResolved"; tabId: string; requestId: string; optionId: string }
  | { type: "chat/approvalsCancelled"; tabId: string }
  | {
      type: "chat/questionAnswered";
      tabId: string;
      requestId: string;
      /** Empty means the user skipped rather than answered. */
      answers: Readonly<Record<string, string>>;
    }
  /** `at` is the caller's clock — the reducer stays pure. */
  | { type: "chat/busyChanged"; tabId: string; busy: boolean; at?: number }
  | {
      type: "chat/draftChanged";
      tabId: string;
      draft: string;
      attachments: readonly string[];
    }
  | {
      type: "chat/promptQueued";
      tabId: string;
      prompt: string;
      attachments: readonly string[];
    }
  | { type: "chat/queueShifted"; tabId: string }
  | { type: "chat/queueRemoved"; tabId: string; index: number }
  | { type: "chat/queueCleared"; tabId: string }
  | {
      type: "chat/sessionRecorded";
      tabId: string;
      provider: ProviderId;
      sessionId: string;
    }
  | { type: "shell/opened"; tabId: string; session: ShellSession }
  | { type: "shell/selected"; tabId: string; sessionId: string }
  /** A command took the shell, or gave it back. Dispatched only when the
   *  answer changes — never per keystroke. */
  | { type: "shell/running"; tabId: string; sessionId: string; running: boolean }
  /** The shell died on its own — a `exit` typed, or a crash. */
  | { type: "shell/exited"; tabId: string; sessionId: string; code: number | null }
  /** The user dismissed the terminal; the pty is killed either way. */
  | { type: "shell/closed"; tabId: string; sessionId: string }
  /** A "!" line is waiting for a terminal with a free prompt. */
  | { type: "shell/lineParked"; tabId: string; line: string }
  /** It found one and was typed into it. */
  | { type: "shell/lineRan"; tabId: string };

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "workspace/restored":
      return {
        tabs: action.tabs,
        activeTabId: action.activeTabId,
        settings: action.settings ?? state.settings,
      };

    case "settings/changed":
      return { ...state, settings: { ...state.settings, ...action.patch } };

    case "tab/opened": {
      const existing = state.tabs.find((t) => t.project.path === action.project.path);
      if (existing) return { ...state, activeTabId: existing.project.id };
      const tab: TabState = {
        project: action.project,
        messages: [],
        busy: false,
        queued: [],
        agentCommands: [],
        plan: [],
        shells: [],
      };
      return { ...state, tabs: [...state.tabs, tab], activeTabId: action.project.id };
    }

    case "tab/closed": {
      const tabs = state.tabs.filter((t) => t.project.id !== action.tabId);
      const activeTabId =
        state.activeTabId === action.tabId
          ? (tabs[tabs.length - 1]?.project.id ?? null)
          : state.activeTabId;
      return { ...state, tabs, activeTabId };
    }

    case "tab/activated":
      // Opening a tab acknowledges its pending attention.
      return {
        ...mapTab(state, action.tabId, (tab) => ({ ...tab, attention: false })),
        activeTabId: action.tabId,
      };

    case "worktree/preparing":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        preparing: true,
        preparingProblem: undefined,
      }));

    case "worktree/prepared":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        preparing: false,
        preparingProblem: action.problem,
      }));

    case "tab/moved": {
      // Reordering is purely cosmetic: which tab you are looking at never
      // changes because you dragged another one past it.
      const from = state.tabs.findIndex((t) => t.project.id === action.tabId);
      if (from === -1) return state;
      const to = Math.min(state.tabs.length - 1, Math.max(0, action.toIndex));
      if (to === from) return state;
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved);
      return { ...state, tabs };
    }

    case "tab/attentionRequested":
      // Never flag the tab the user is already looking at.
      if (state.activeTabId === action.tabId) return state;
      return mapTab(state, action.tabId, (tab) => ({ ...tab, attention: true }));

    case "tab/providerChanged":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        project: { ...tab.project, provider: action.provider },
      }));

    case "tab/modeChanged":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        project: { ...tab.project, mode: action.mode },
      }));

    case "tab/permissionChanged":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        project: { ...tab.project, permission: action.permission },
      }));

    case "tab/modelChanged":
      return mapTab(state, action.tabId, (tab) =>
        usageReseededForModel({
          ...tab,
          project: { ...tab.project, model: action.model.trim() || undefined },
        }),
      );

    case "tab/effortChanged":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        project: { ...tab.project, effort: action.effort.trim() || undefined },
      }));

    case "tab/specDeferred":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        pendingSpec: deferredSpec(tab, action),
      }));

    case "tab/pendingSpecApplied":
      return mapTab(state, action.tabId, (tab) => {
        // An effort-only deferral stays on the same model, so its
        // context window — and any reported usage — is still valid.
        const modelChanged = tab.pendingSpec?.model !== undefined;
        const applied = applyPendingSpec(tab);
        return modelChanged ? usageReseededForModel(applied) : applied;
      });

    case "tab/pendingSpecDiscarded":
      return mapTab(state, action.tabId, ({ pendingSpec: _, ...tab }) => tab);

    case "tab/contextFullChanged":
      return mapTab(state, action.tabId, ({ contextFullPercent: _, ...tab }) =>
        action.percent === undefined
          ? tab
          : { ...tab, contextFullPercent: action.percent },
      );

    case "tab/mcpOverrideChanged":
      return mapTab(state, action.tabId, (tab) => {
        const overrides = { ...tab.project.mcpOverrides };
        // Clearing must REMOVE the key, not store a false: absent means
        // "follow the provider toggle", which false would silently pin.
        if (action.enabled === undefined) delete overrides[action.serverId];
        else overrides[action.serverId] = action.enabled;
        return { ...tab, project: { ...tab.project, mcpOverrides: overrides } };
      });

    case "tab/provisioningChanged":
      // Clearing must REMOVE the key, not store []: absent means "follow
      // the app default", which an empty list would silently pin.
      return mapTab(state, action.tabId, (tab) => {
        const { provisioningOverride: _, ...project } = tab.project;
        return {
          ...tab,
          project:
            action.provisioning === undefined
              ? project
              : { ...project, provisioningOverride: action.provisioning },
        };
      });

    case "tab/verboseChanged":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        project: { ...tab.project, verbose: action.verbose },
      }));

    // Both delete their key when cleared rather than storing a blank, the
    // same tri-state mcpOverrides and provisioningOverride already keep:
    // absent means "the user never named one", and an empty string or an
    // explicit undefined would read as a choice that was made.
    case "tab/labelChanged":
      return mapTab(state, action.tabId, (tab) => {
        const { label: _, ...project } = tab.project;
        const label = normalizedTabLabel(action.label);
        return { ...tab, project: label ? { ...project, label } : project };
      });

    case "tab/colorChanged":
      return mapTab(state, action.tabId, (tab) => {
        const { color: _, ...project } = tab.project;
        return {
          ...tab,
          project: action.color ? { ...project, color: action.color } : project,
        };
      });

    case "tab/commandsUpdated":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        agentCommands: action.commands,
      }));

    case "tab/planUpdated":
      return mapTab(state, action.tabId, (tab) => ({ ...tab, plan: action.plan }));

    // A NEW plan-mode plan supersedes the previous plan entirely: the
    // old checklist would otherwise keep winning in the plan view (it
    // renders before markdown), and the old file path would resurrect
    // the old plan on reopen.
    case "tab/planMarkdownUpdated":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        plan: [],
        planMarkdown: action.markdown,
        planFilePath: action.filePath,
      }));

    case "tab/usageUpdated":
      // `provisional` is derived here, not carried on the action: every
      // path that reports usage (live turn, history replay) gets the
      // same verdict on whether the size is the adapter's placeholder.
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        usage: {
          used: action.used,
          size: action.size,
          ...(action.estimated ? { estimated: true } : {}),
          ...(!action.estimated &&
          isProvisionalContextSize(tab.project.provider, tab.project.model, action.size)
            ? { provisional: true }
            : {}),
        },
      }));

    case "chat/sessionReset":
      return mapTab(state, action.tabId, (tab) => {
        // A change was only ever deferred because a conversation was
        // live. Ending it is the moment the change becomes free, so this
        // is where a deferral resolves — the next session boots with it.
        const applied = applyPendingSpec(tab);
        const sessions = { ...applied.project.providerSessions };
        delete sessions[action.provider];
        return {
          ...applied,
          usage: undefined,
          agentCommands: [],
          project: { ...applied.project, providerSessions: sessions },
        };
      });

    case "tab/sessionStageChanged":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        sessionStage: action.stage,
      }));

    case "tab/branchUpdated":
      return mapTab(state, action.tabId, (tab) => ({ ...tab, branch: action.branch }));

    case "chat/messageAppended":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        messages: [...tab.messages, action.message],
      }));

    // A tool call progressed: update its message in place. Exactly one
    // message object changes, so memoized rows elsewhere don't re-render.
    case "chat/toolCallUpdated":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        messages: tab.messages.map((m) =>
          m.toolCall?.toolCallId === action.toolCallId
            ? {
                ...m,
                text: action.patch.title ?? m.text,
                toolCall: mergeToolCall(m.toolCall, action.patch),
              }
            : m,
        ),
      }));

    case "chat/assistantDelta":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        messages: appendDelta(tab.messages, action.text, "assistant"),
      }));

    case "chat/userDelta":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        messages: appendDelta(tab.messages, action.text, "user"),
      }));

    case "chat/thoughtDelta":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        messages: appendDelta(tab.messages, action.text, "thought"),
      }));

    case "chat/historySessionAssigned":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        historySessionId: action.sessionId,
        // Settled either way: the claim was adopted, or a new transcript
        // took its place. Nothing left to reconcile.
        restoredHistorySessionId: undefined,
      }));

    // Like chat/toolCallUpdated: exactly one message object changes, so
    // memoized rows elsewhere don't re-render. The `turn` guard makes an
    // unknown or replayed id a no-op.
    case "chat/turnMetaCompleted":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        messages: tab.messages.map((m) =>
          m.id === action.messageId && m.turn
            ? { ...m, turn: { ...m.turn, ...action.patch } }
            : m,
        ),
      }));

    case "chat/transcriptLoaded":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        messages: action.messages,
        historySessionId: action.sessionId,
        restoredHistorySessionId: undefined,
        plan: action.plan ?? [],
        planMarkdown: action.planMarkdown,
        // Landing the conversation and the session it runs in as ONE
        // update: a transcript is painted in a single render, and the
        // next save must not stamp the session the tab left behind.
        project: action.providerSessionId
          ? {
              ...tab.project,
              providerSessions: {
                ...tab.project.providerSessions,
                [tab.project.provider]: action.providerSessionId,
              },
            }
          : tab.project,
      }));

    case "chat/cleared":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        messages: [],
        historySessionId: undefined,
        restoredHistorySessionId: undefined,
        plan: [],
        planMarkdown: undefined,
      }));

    case "chat/approvalResolved":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        messages: tab.messages.map((m) =>
          m.approval?.requestId === action.requestId
            ? { ...m, approval: { ...m.approval, resolvedOptionId: action.optionId } }
            : m,
        ),
      }));

    case "chat/questionAnswered":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        messages: tab.messages.map((m) =>
          m.question?.requestId === action.requestId
            ? {
                ...m,
                question: {
                  ...m.question,
                  answers: action.answers,
                  skipped: Object.keys(action.answers).length === 0,
                },
              }
            : m,
        ),
      }));

    case "chat/approvalsCancelled":
      // Questions are released by the same event: the turn ending strands
      // both, and both must stop looking answerable.
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        messages: tab.messages.map((m) => {
          if (m.approval && !m.approval.resolvedOptionId && !m.approval.cancelled) {
            return { ...m, approval: { ...m.approval, cancelled: true } };
          }
          if (m.question && !m.question.answers && !m.question.cancelled) {
            return { ...m, question: { ...m.question, cancelled: true } };
          }
          return m;
        }),
      }));

    case "chat/busyChanged":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        busy: action.busy,
        turnStartedAt: action.busy ? (action.at ?? tab.turnStartedAt) : undefined,
      }));

    case "chat/draftChanged":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        draft: action.draft,
        draftAttachments: action.attachments,
      }));

    case "chat/promptQueued":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        queued: [
          ...tab.queued,
          { prompt: action.prompt, attachments: action.attachments },
        ],
      }));

    case "chat/queueShifted":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        queued: tab.queued.slice(1),
      }));

    case "chat/queueRemoved":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        queued: tab.queued.filter((_, i) => i !== action.index),
      }));

    case "chat/queueCleared":
      return mapTab(state, action.tabId, (tab) => ({ ...tab, queued: [] }));

    case "chat/sessionRecorded":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        project: {
          ...tab.project,
          providerSessions: {
            ...tab.project.providerSessions,
            [action.provider]: action.sessionId,
          },
        },
      }));

    case "shell/opened":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        shells: [...tab.shells, action.session],
        activeShellId: action.session.id,
      }));

    case "shell/selected":
      return mapTab(state, action.tabId, (tab) =>
        tab.shells.some((s) => s.id === action.sessionId)
          ? { ...tab, activeShellId: action.sessionId }
          : tab,
      );

    case "shell/running":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        shells: tab.shells.map((s) =>
          s.id === action.sessionId ? { ...s, running: action.running } : s,
        ),
      }));

    case "shell/exited":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        shells: tab.shells.map((s) =>
          // First exit wins: a kill racing the shell's own exit must not
          // overwrite the status the user is looking at.
          s.id === action.sessionId && !s.exit
            ? // Whatever was running died with the shell.
              { ...s, exit: { code: action.code }, running: false }
            : s,
        ),
      }));

    case "shell/closed":
      return mapTab(state, action.tabId, (tab) => {
        const { activeShellId: _, ...rest } = tab;
        const selected =
          tab.activeShellId === action.sessionId
            ? shellAfterClosing(tab.shells, action.sessionId)
            : tab.activeShellId;
        return {
          ...rest,
          shells: tab.shells.filter((s) => s.id !== action.sessionId),
          ...(selected === undefined ? {} : { activeShellId: selected }),
        };
      });

    case "shell/lineParked":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        pendingShellLine: action.line,
      }));

    case "shell/lineRan":
      return mapTab(state, action.tabId, ({ pendingShellLine: _, ...tab }) => tab);
  }
}

/**
 * Streamed text: extends the last message when it has the same role.
 * The use case dispatches `chat/messageAppended` instead when a new
 * bubble must start, keeping this reducer pure.
 */
function appendDelta(
  messages: readonly ChatMessage[],
  text: string,
  role: MessageRole,
): readonly ChatMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== role) return messages;
  return [...messages.slice(0, -1), { ...last, text: last.text + text }];
}

function mapTab(
  state: AppState,
  tabId: string,
  update: (tab: TabState) => TabState,
): AppState {
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.project.id === tabId ? update(t) : t)),
  };
}

/**
 * The pending spec after one deferred change, or undefined when nothing
 * is left pending.
 *
 * Only genuine differences survive. Picking the value the session is
 * already running is not a pending change, and neither is picking a new
 * value and then picking the old one back — either would leave the
 * toolbar promising a restart that would do nothing.
 */
function deferredSpec(
  tab: TabState,
  change: { readonly model?: string; readonly effort?: string },
): TabState["pendingSpec"] {
  const merged = { ...tab.pendingSpec, ...change };
  const differs = (value: string | undefined, current: string | undefined) =>
    value !== undefined && value !== (current ?? "");
  const pending = {
    ...(differs(merged.model, tab.project.model) ? { model: merged.model } : {}),
    ...(differs(merged.effort, tab.project.effort) ? { effort: merged.effort } : {}),
  };
  return "model" in pending || "effort" in pending ? pending : undefined;
}

/**
 * A model change moves the tab to a different context window, so an
 * agent-reported size from the OLD model must not linger as the gauge's
 * — and auto-compact's — denominator. Downgraded to an estimate rather
 * than cleared: `used` is still the best signal available, and the
 * respawned agent's first real `usage_update` replaces it wholesale.
 */
function usageReseededForModel(tab: TabState): TabState {
  if (!tab.usage) return tab;
  return {
    ...tab,
    usage: {
      used: tab.usage.used,
      size: contextWindowFor(tab.project.provider, tab.project.model),
      estimated: true,
    },
  };
}

/** Fold a pending model/effort into the project and clear it. */
function applyPendingSpec(tab: TabState): TabState {
  const { pendingSpec, ...rest } = tab;
  if (!pendingSpec) return tab;
  return {
    ...rest,
    project: {
      ...tab.project,
      ...(pendingSpec.model !== undefined
        ? { model: pendingSpec.model.trim() || undefined }
        : {}),
      ...(pendingSpec.effort !== undefined
        ? { effort: pendingSpec.effort.trim() || undefined }
        : {}),
    },
  };
}

/**
 * The app defaults, flattened for one provider: the model and effort are
 * stored per provider, but a project only ever has one of each.
 */
export function projectDefaults(settings: AppSettings): ProjectDefaults {
  const provider = settings.defaultProvider;
  return {
    provider,
    mode: settings.defaultMode,
    permission: settings.defaultPermission,
    model: settings.defaultModel[provider],
    effort: settings.defaultEffort[provider],
  };
}

export function activeTab(state: AppState): TabState | null {
  return state.tabs.find((t) => t.project.id === state.activeTabId) ?? null;
}

export function tabById(state: AppState, tabId: string): TabState | null {
  return state.tabs.find((t) => t.project.id === tabId) ?? null;
}
