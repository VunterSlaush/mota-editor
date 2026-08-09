import type { AgentMode, PermissionPolicy } from "../entities/agentSettings";
import { DEFAULT_MODE, DEFAULT_PERMISSION } from "../entities/agentSettings";
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
import type { ProviderId } from "../entities/provider";
import { DEFAULT_PROVIDER } from "../entities/provider";

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
  /** True when a turn finished while the user was on another tab. */
  readonly attention?: boolean;
  /** Context-window usage of the tab's agent session. `estimated` marks
   *  a client-side approximation (no `usage_update` from the agent). */
  readonly usage?: {
    readonly used: number;
    readonly size: number;
    readonly estimated?: boolean;
  };
  /** Where session startup stands (installing|booting|creating|recovering);
   *  undefined once ready or failed. */
  readonly sessionStage?: string;
  /** The project's current git branch, cached from the last git read —
   *  tooltips read this instead of asking git on every hover. */
  readonly branch?: string;
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
  /** Color theme id, from `entities/theme`. */
  readonly theme: string;
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
  autoCompactThreshold: 0.85,
  theme: "mota-dark",
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
  | { type: "tab/activated"; tabId: string }
  | { type: "tab/moved"; tabId: string; toIndex: number }
  | { type: "tab/attentionRequested"; tabId: string }
  | { type: "tab/providerChanged"; tabId: string; provider: ProviderId }
  | { type: "tab/modeChanged"; tabId: string; mode: AgentMode }
  | { type: "tab/permissionChanged"; tabId: string; permission: PermissionPolicy }
  | { type: "tab/modelChanged"; tabId: string; model: string }
  | { type: "tab/effortChanged"; tabId: string; effort: string }
  | { type: "tab/verboseChanged"; tabId: string; verbose: boolean }
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
    };

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
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        project: { ...tab.project, model: action.model.trim() || undefined },
      }));

    case "tab/effortChanged":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        project: { ...tab.project, effort: action.effort.trim() || undefined },
      }));

    case "tab/verboseChanged":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        project: { ...tab.project, verbose: action.verbose },
      }));

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
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        usage: {
          used: action.used,
          size: action.size,
          ...(action.estimated ? { estimated: true } : {}),
        },
      }));

    case "chat/sessionReset":
      return mapTab(state, action.tabId, (tab) => {
        const sessions = { ...tab.project.providerSessions };
        delete sessions[action.provider];
        return {
          ...tab,
          usage: undefined,
          agentCommands: [],
          project: { ...tab.project, providerSessions: sessions },
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
        plan: action.plan ?? [],
        planMarkdown: action.planMarkdown,
      }));

    case "chat/cleared":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        messages: [],
        historySessionId: undefined,
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
