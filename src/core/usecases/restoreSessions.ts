import type { ChatMessage } from "../entities/message";
import { infoMessage } from "../entities/message";
import { providerById } from "../entities/provider";
import type { AgentGateway } from "../ports/agentGateway";
import type { TranscriptStore } from "../ports/transcriptStore";
import type { TabState } from "../state/appState";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import { agentServers } from "./agentServers";
import { warmTab } from "./warmSessions";

/** Said once the agent has the conversation back in memory. */
const REJOINED = "Picked up where you left off — the agent remembers this conversation.";

/** Said when only the transcript came back, not the agent's memory. */
const PAINTED_ONLY =
  "Reopened from your last session — the agent starts fresh and doesn't have this conversation in memory.";

/**
 * Use case (startup step) — put every restored tab back into the
 * conversation it was in, rather than an empty new chat.
 *
 * Two halves, in that order because they cost so differently. The
 * transcript is ours, on disk, and paints in a file read: the tab looks
 * right on the first frame. Rejoining the AGENT means booting it and
 * asking it to take the conversation back, which is tens of seconds —
 * so it runs behind the paint, per tab, and says how it went.
 *
 * A tab with nothing to restore is simply warmed, which is what startup
 * did for every tab before this existed.
 *
 * Every tab goes at once and none of them can fail the others: the
 * returned promise is for tests and for nothing else — startup does not
 * wait on it, and must not.
 */
export function restoreSessions(
  store: Store,
  transcriptStore: TranscriptStore,
  agentGateway: AgentGateway,
): Promise<void> {
  const tabs = store.getState().tabs;
  return Promise.all(
    tabs.map((tab) => restoreTab(store, transcriptStore, agentGateway, tab)),
  ).then(() => undefined);
}

async function restoreTab(
  store: Store,
  transcriptStore: TranscriptStore,
  agentGateway: AgentGateway,
  tab: TabState,
): Promise<void> {
  const tabId = tab.project.id;
  const path = tab.project.path;
  const sessionId = tab.restoredHistorySessionId;
  if (!sessionId) {
    warmTab(store, agentGateway, tabId);
    return;
  }

  const transcript = await transcriptStore.load(path, sessionId).catch(() => null);
  // Nothing saved under the claim — the file was deleted, or the tab was
  // closed before its first message. A new chat is the honest answer.
  if (!transcript || transcript.messages.length === 0) {
    warmTab(store, agentGateway, tabId);
    return;
  }

  // The plan is stored as a PATH — read the content back, as reopening
  // from the History panel does.
  const planMarkdown = transcript.planFilePath
    ? await transcriptStore.readPlanFile(path, transcript.planFilePath).catch(() => null)
    : null;

  store.dispatch({
    type: "chat/transcriptLoaded",
    tabId,
    sessionId,
    messages: withoutLaunchNotes(transcript.messages).map((message, index) => ({
      ...message,
      id: `${sessionId}-${index}`,
    })),
    plan: transcript.plan,
    planMarkdown: planMarkdown ?? undefined,
    providerSessionId: transcript.providerSessionId,
  });

  await rejoinAgent(store, agentGateway, tabId, transcript.providerSessionId);
}

/**
 * The conversation without the notes an earlier launch left in it.
 *
 * The transcript is saved with whatever is on screen, this app's own
 * asides included — so a note about starting up, left in and painted
 * back, would earn the conversation one more of itself on every launch.
 * Matched on the exact text because both strings are this module's: it
 * only ever drops what it wrote.
 */
function withoutLaunchNotes(messages: readonly ChatMessage[]): readonly ChatMessage[] {
  return messages.filter(
    (m) => m.role !== "info" || (m.text !== REJOINED && m.text !== PAINTED_ONLY),
  );
}

/**
 * Ask the agent to take the conversation back, so the next message
 * continues it instead of opening on a stranger.
 *
 * `preferResume` is set because the screen already holds the
 * conversation: the agent may then attach without replaying it, which
 * is the difference between a second and a minute. The replay it sends
 * when it cannot is dropped for the same reason.
 */
async function rejoinAgent(
  store: Store,
  agentGateway: AgentGateway,
  tabId: string,
  providerSessionId: string | undefined,
): Promise<void> {
  const state = store.getState();
  const tab = tabById(state, tabId);
  if (!tab) return;
  const { provider, path, model, effort, mcpOverrides } = tab.project;

  // No id the agent would recognise (a transcript from before we
  // recorded one), or a provider that cannot be asked. Either way the
  // conversation is on screen and nowhere else — say so.
  if (!providerSessionId || !providerById(provider).supportsResume) {
    warmTab(store, agentGateway, tabId);
    note(store, tabId, PAINTED_ONLY);
    return;
  }

  store.dispatch({ type: "tab/sessionStageChanged", tabId, stage: "recovering" });
  try {
    await agentGateway.loadNativeSession(
      {
        tabId,
        provider,
        projectPath: path,
        model,
        effort,
        sessionId: providerSessionId,
        mcpServers: agentServers(state, provider, mcpOverrides),
        preferResume: true,
      },
      () => undefined,
    );
    note(store, tabId, REJOINED);
  } catch {
    // The agent is gone, was upgraded, or pruned the session. The
    // transcript stays — it is still the conversation this tab is in,
    // and the next message appends to it as it always did.
    warmTab(store, agentGateway, tabId);
    note(store, tabId, PAINTED_ONLY);
  } finally {
    store.dispatch({ type: "tab/sessionStageChanged", tabId, stage: undefined });
  }
}

function note(store: Store, tabId: string, text: string): void {
  store.dispatch({ type: "chat/messageAppended", tabId, message: infoMessage(text) });
}
