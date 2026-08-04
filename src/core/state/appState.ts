import type { AgentMode, PermissionPolicy } from "../entities/agentSettings";
import type { CommandInfo } from "../entities/command";
import type { ChatMessage, MessageRole } from "../entities/message";
import type { PlanEntry } from "../entities/plan";
import type { Project } from "../entities/project";
import type { ProviderId } from "../entities/provider";

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
  /** Context-window usage of the tab's agent session. */
  readonly usage?: { readonly used: number; readonly size: number };
}

/** App-wide preferences, persisted with the workspace. */
export interface AppSettings {
  readonly defaultProvider: ProviderId;
}

export interface AppState {
  readonly tabs: readonly TabState[];
  readonly activeTabId: string | null;
  readonly settings: AppSettings;
}

export const initialState: AppState = {
  tabs: [],
  activeTabId: null,
  settings: { defaultProvider: "claude" },
};

export type Action =
  | {
      type: "workspace/restored";
      tabs: readonly TabState[];
      activeTabId: string | null;
      settings?: AppSettings;
    }
  | { type: "settings/defaultProviderChanged"; provider: ProviderId }
  | { type: "tab/opened"; project: Project }
  | { type: "tab/closed"; tabId: string }
  | { type: "tab/activated"; tabId: string }
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
  | { type: "tab/usageUpdated"; tabId: string; used: number; size: number }
  | { type: "chat/messageAppended"; tabId: string; message: ChatMessage }
  | { type: "chat/assistantDelta"; tabId: string; text: string }
  | { type: "chat/userDelta"; tabId: string; text: string }
  | { type: "chat/thoughtDelta"; tabId: string; text: string }
  | { type: "chat/historySessionAssigned"; tabId: string; sessionId: string }
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
  | { type: "chat/busyChanged"; tabId: string; busy: boolean }
  | { type: "chat/promptQueued"; tabId: string; prompt: string; attachments: readonly string[] }
  | { type: "chat/queueShifted"; tabId: string }
  | { type: "chat/queueRemoved"; tabId: string; index: number }
  | { type: "chat/queueCleared"; tabId: string }
  | { type: "chat/sessionRecorded"; tabId: string; provider: ProviderId; sessionId: string };

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "workspace/restored":
      return {
        tabs: action.tabs,
        activeTabId: action.activeTabId,
        settings: action.settings ?? state.settings,
      };

    case "settings/defaultProviderChanged":
      return { ...state, settings: { ...state.settings, defaultProvider: action.provider } };

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

    case "tab/planMarkdownUpdated":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        planMarkdown: action.markdown,
        planFilePath: action.filePath ?? tab.planFilePath,
      }));

    case "tab/usageUpdated":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        usage: { used: action.used, size: action.size },
      }));

    case "chat/messageAppended":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        messages: [...tab.messages, action.message],
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

    case "chat/approvalsCancelled":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        messages: tab.messages.map((m) =>
          m.approval && !m.approval.resolvedOptionId && !m.approval.cancelled
            ? { ...m, approval: { ...m.approval, cancelled: true } }
            : m,
        ),
      }));

    case "chat/busyChanged":
      return mapTab(state, action.tabId, (tab) => ({ ...tab, busy: action.busy }));

    case "chat/promptQueued":
      return mapTab(state, action.tabId, (tab) => ({
        ...tab,
        queued: [...tab.queued, { prompt: action.prompt, attachments: action.attachments }],
      }));

    case "chat/queueShifted":
      return mapTab(state, action.tabId, (tab) => ({ ...tab, queued: tab.queued.slice(1) }));

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

export function activeTab(state: AppState): TabState | null {
  return state.tabs.find((t) => t.project.id === state.activeTabId) ?? null;
}

export function tabById(state: AppState, tabId: string): TabState | null {
  return state.tabs.find((t) => t.project.id === tabId) ?? null;
}
