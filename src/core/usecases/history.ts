import { serversForProvider } from "../entities/mcpServer";
import {
  type ChatMessage,
  errorMessage,
  infoMessage,
  mergeToolCall,
  toolCallMessage,
  toolMessage,
} from "../entities/message";
import type { PlanEntry } from "../entities/plan";
import { projectNameFromPath } from "../entities/project";
import { samePath } from "../entities/worktree";
import type { AgentGateway, AgentTurnEvent } from "../ports/agentGateway";
import type { TranscriptMeta, TranscriptStore } from "../ports/transcriptStore";
import type { TabState } from "../state/appState";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import { startNewChat } from "./startNewChat";
import type { WorktreeItem } from "./worktrees";

/** One history row: a transcript's metadata plus how it opens. */
export interface HistoryItem extends TranscriptMeta {
  /** True when the AGENT lists this session (opening truly resumes). */
  readonly native: boolean;
  /**
   * True when we hold our own transcript for it — it paints without an
   * agent, it is what a resume is painted FROM, and it is ours to
   * delete. A row can be both: one conversation, two records of it.
   */
  readonly local: boolean;
  /**
   * The checkout this session was had in, whenever there is something
   * worth saying about it — it is a worktree, or it is not this tab's,
   * or both. Absent only for a main checkout's own sessions, which are
   * the unremarkable case.
   *
   * A conversation belongs to the repository, not to the folder git
   * happened to lay it out in: work started in a worktree is the same
   * work, and the main checkout is where you go looking for it after
   * the worktree's tab has been closed.
   */
  readonly from?: SessionOrigin;
}

/** The checkout a session was had in. */
export interface SessionOrigin {
  /** Its folder — where the transcript lives, and what deletes it. */
  readonly path: string;
  /** Its branch, or its folder when the HEAD is detached. */
  readonly label: string;
  /**
   * A linked worktree rather than the repository's main checkout. This
   * is what the badge says, and it is a fact about the session — true
   * on a worktree's own tab as much as on the main checkout that
   * borrowed the row, because it was a worktree either way.
   */
  readonly worktree: boolean;
  /**
   * Not the tab the panel is being shown from: opening this row has to
   * open or activate another tab first, and deleting it reaches into
   * another folder. Relative, unlike `worktree` — which is why the two
   * are separate answers rather than one flag doing both jobs badly.
   */
  readonly elsewhere: boolean;
}

/**
 * What history needs from the repository's other checkouts: what they
 * are, and how to bring one onto the tab bar. Both are `Worktrees`'
 * job — named here as the narrow slice this use case actually calls,
 * so it depends on the two verbs rather than on that whole class.
 */
export interface WorktreeAccess {
  list(tabId: string): Promise<readonly WorktreeItem[]>;
  open(worktreePath: string, mainPath: string, sourceTabId?: string): Promise<void>;
}

/** The history list plus where it came from. */
export interface HistoryListing {
  /** True when any entries are the AGENT's own sessions (true resume). */
  readonly native: boolean;
  readonly sessions: readonly HistoryItem[];
  /**
   * Why the native listing failed, when it did and there was nothing
   * local to show instead. An empty panel that could mean "no sessions"
   * or "the agent broke" is undebuggable — say which.
   */
  readonly error?: string;
}

/**
 * A replayed session, folded in memory before it reaches the store.
 *
 * The agent replays a saved conversation one event at a time. Dispatching
 * each one made the transcript build itself on screen and the view chase
 * the bottom all the way down; collecting them here means the whole
 * conversation arrives in a single update, already scrolled to the end.
 */
class ReplayedSession {
  readonly messages: ChatMessage[] = [];
  plan: readonly PlanEntry[] = [];
  /** The last usage the replay reported, restored with the transcript. */
  usage?: { used: number; size: number };
  /** Replayed tool calls by id, so their updates fold into place. */
  private readonly toolCalls = new Map<string, number>();

  /** Replay events → chat messages, at full fidelity: thoughts, tool
   *  calls with their final status/output, errors, and usage all come
   *  back. (Approvals/questions don't replay — they were answered.) */
  fold(event: AgentTurnEvent): void {
    switch (event.kind) {
      case "userDelta":
        this.appendOrExtend("user", event.text);
        break;
      case "assistantDelta":
        this.appendOrExtend("assistant", event.text);
        break;
      case "thoughtDelta":
        this.appendOrExtend("thought", event.text);
        break;
      case "tool":
        this.messages.push(toolMessage(event.name, event.detail));
        break;
      case "toolCall": {
        this.toolCalls.set(event.toolCallId, this.messages.length);
        this.messages.push(
          toolCallMessage(event.toolCallId, event.toolKind, event.title, event.status),
        );
        break;
      }
      case "toolCallUpdate": {
        const index = this.toolCalls.get(event.toolCallId);
        const message = index === undefined ? undefined : this.messages[index];
        if (index === undefined || !message?.toolCall) break;
        this.messages[index] = {
          ...message,
          text: event.title ?? message.text,
          toolCall: mergeToolCall(message.toolCall, event),
        };
        break;
      }
      case "error":
        this.messages.push(
          errorMessage(event.message, {
            context: event.context,
            stderrTail: event.stderrTail,
          }),
        );
        break;
      case "usage":
        this.usage = { used: event.used, size: event.size };
        break;
      case "plan":
        this.plan = event.entries;
        break;
      default:
        break; // session ids, stages, completions: not part of the view
    }
  }

  note(text: string): void {
    this.messages.push(infoMessage(text));
  }

  /** Streamed text extends the last message when the role still matches. */
  private appendOrExtend(role: "user" | "assistant" | "thought", text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === role) {
      this.messages[this.messages.length - 1] = { ...last, text: last.text + text };
      return;
    }
    this.messages.push({ id: `r-${this.messages.length}`, role, text });
  }
}

/**
 * Use cases — the session-history panel. Local-first: our own
 * transcript store paints the list instantly (it never needs an agent
 * process), and the AGENT's native listing arrives as a background
 * refresh — asked only of a session that is already live, never worth
 * booting one for. Native entries win the merge, so opening them truly
 * resumes with the agent's memory.
 */
export class SessionHistory {
  constructor(
    private readonly store: Store,
    private readonly transcriptStore: TranscriptStore,
    private readonly agentGateway: AgentGateway,
    private readonly worktrees: WorktreeAccess,
  ) {}

  /**
   * The listing to paint NOW, from the local store alone — this tab's
   * folder plus, on a main checkout, every worktree of the repository.
   * When `onRefresh` is given, the native listing and the vendor's own
   * store are fetched in the background and the merged result delivered
   * through it — or nothing, when neither adds to the local paint.
   */
  async list(
    tabId: string,
    onRefresh?: (listing: HistoryListing) => void,
  ): Promise<HistoryListing> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return { native: false, sessions: [] };

    const [local, elsewhere] = await Promise.all([
      this.transcriptStore.list(tab.project.path).catch(() => []),
      this.listWorktreeSessions(tabId),
    ]);
    const own = this.ownOrigin(tab);
    if (onRefresh) void this.refreshFromAgent(tabId, local, elsewhere, onRefresh);
    return {
      native: false,
      sessions: byNewest([
        ...local.map((m) => ({ ...m, native: false, local: true, ...own })),
        ...elsewhere,
      ]),
    };
  }

  /**
   * What this tab's OWN sessions say about where they happened: nothing
   * on a main checkout, and "this worktree" on a worktree's tab.
   *
   * A session had in a worktree was had in a worktree wherever it is
   * being listed. Saying so only on the tab that borrowed the row would
   * make the badge mean "somewhere else" rather than "in a worktree",
   * and leave a worktree's own history unable to say what it is.
   */
  private ownOrigin(tab: TabState): { from?: SessionOrigin } {
    if (!tab.project.worktreeOf) return {};
    return {
      from: {
        path: tab.project.path,
        label: tab.branch || projectNameFromPath(tab.project.path),
        worktree: true,
        elsewhere: false,
      },
    };
  }

  /**
   * The conversations had in this repository's OTHER checkouts, newest
   * first. Empty on a worktree's own tab: a worktree lists its own
   * sessions and nothing else, because the whole-repository view is
   * what the main checkout is for.
   *
   * Local records only. The agent's native listing is answered by a
   * session that is already live for THIS tab's folder, so it has
   * nothing to say about another one — a worktree's own tab is where
   * its sessions can be resumed with the agent's memory.
   */
  async listWorktreeSessions(tabId: string): Promise<HistoryItem[]> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab || tab.project.worktreeOf) return [];

    const checkouts = await this.worktrees.list(tabId).catch(() => []);
    const others = checkouts.filter((w) => !w.bare && !w.current && !w.prunable);
    const lists = await Promise.all(
      others.map(async (worktree) => {
        const metas = await this.transcriptStore.list(worktree.path).catch(() => []);
        const from: SessionOrigin = {
          path: worktree.path,
          label: originLabel(worktree),
          worktree: !worktree.main,
          elsewhere: true,
        };
        return metas.map((m) => ({ ...m, native: false, local: true, from }));
      }),
    );
    return byNewest(lists.flat());
  }

  /**
   * Overlay the agent's own sessions on the local listing. A native
   * session and our transcript of it are ONE conversation and must be
   * one row: they are matched on the provider's session id, the only id
   * both sides share. Matched rows resume like a native one and still
   * paint from (and delete) our copy; local-only transcripts stay (the
   * agent may have pruned them, or never owned them); sessions the
   * agent knows and we never saw appear (created outside this app).
   *
   * The vendor's own store is read alongside (Claude only): it lists
   * sessions started OUTSIDE this app without booting an agent to ask,
   * so they appear even when no live session exists. The live agent's
   * listing wins where the two overlap.
   */
  private async refreshFromAgent(
    tabId: string,
    local: readonly TranscriptMeta[],
    elsewhere: readonly HistoryItem[],
    onRefresh: (listing: HistoryListing) => void,
  ): Promise<void> {
    const state = this.store.getState();
    const tab = tabById(state, tabId);
    if (!tab) return;
    const { provider, path, model, effort, mcpOverrides } = tab.project;

    // Only Claude's store is readable without an agent; other vendors'
    // history stays whatever the live agent reports.
    const externalPromise =
      provider === "claude"
        ? this.transcriptStore.listExternal(path).catch(() => [])
        : Promise.resolve([]);

    let native: Awaited<ReturnType<AgentGateway["listNativeSessions"]>> = null;
    let listError: string | undefined;
    try {
      native = await this.agentGateway.listNativeSessions(
        tabId,
        provider,
        path,
        model,
        effort,
        serversForProvider(state.settings.mcpServers, provider, mcpOverrides),
      );
    } catch (e) {
      listError = e instanceof Error ? e.message : String(e);
    }
    const external = await externalPromise;

    const twins = transcriptsByProviderSession(local);
    const nativeSessions = (native ?? [])
      // One malformed entry must not throw the whole list away.
      .filter((s) => typeof s.sessionId === "string" && s.sessionId !== "")
      .map((s) => {
        const known = twins.get(s.sessionId);
        const updatedAt = s.updatedAt ? Date.parse(s.updatedAt) : Number.NaN;
        return {
          // Our own id when we have a copy: the row then opens, saves
          // and deletes as that transcript instead of forking a second
          // one the moment it is opened.
          id: known?.id ?? s.sessionId,
          providerSessionId: s.sessionId,
          title: known?.title || s.title?.trim() || s.sessionId.slice(0, 8),
          // Our transcript is saved only when a MESSAGE is sent, while
          // the agent's `updatedAt` also bumps on a mere open (loading
          // touches its session file). Our timestamp, when we have one,
          // keeps the list ordered by last message, not last look.
          savedAt: known?.savedAt ?? (Number.isNaN(updatedAt) ? 0 : updatedAt),
          provider,
          messageCount: known?.messageCount,
          native: true,
          local: known !== undefined,
        };
      });
    const listed = new Set(nativeSessions.map((s) => s.providerSessionId));
    const externalSessions = external
      .filter((s) => s.sessionId !== "" && !listed.has(s.sessionId))
      .map((s) => {
        const known = twins.get(s.sessionId);
        return {
          id: known?.id ?? s.sessionId,
          providerSessionId: s.sessionId,
          title: known?.title || s.title.trim() || s.sessionId.slice(0, 8),
          savedAt: known?.savedAt ?? s.updatedAtMs,
          provider,
          messageCount: known?.messageCount,
          // The store is shared with the agent, so opening truly resumes.
          native: true,
          local: known !== undefined,
        };
      });

    const agentRows = [...nativeSessions, ...externalSessions];
    if (agentRows.length === 0) {
      // Best-effort refresh: the local list already painted. Only an
      // EMPTY panel needs the failure spelled out.
      if (listError && local.length === 0 && elsewhere.length === 0) {
        onRefresh({ native: false, sessions: [], error: listError });
      }
      return; // nothing beyond the local paint
    }
    const merged = new Set(agentRows.map((s) => s.id));
    // The worktrees' rows ride through untouched: the agent was asked
    // about THIS folder, so it has neither confirmed nor contradicted
    // them, and dropping them would make the refresh look like a purge.
    const sessions = byNewest([
      ...agentRows,
      ...local
        .filter((m) => !merged.has(m.id))
        .map((m) => ({ ...m, native: false, local: true })),
      ...elsewhere,
    ]);
    onRefresh({ native: true, sessions });
  }

  /**
   * What every listed session was about, by session id — the index the
   * panel's search matches against once the title has run out of answers.
   *
   * Built on demand and covering exactly the checkouts `list` covers, so
   * a search reaches every row on screen and no folder that is not. The
   * caller holds the result for the rest of its life: this is the one
   * expensive read in the History panel, and it is worth paying once.
   *
   * Two checkouts can hold a record of the SAME conversation (a worktree
   * forked from a session, an id that travelled with a copied folder),
   * so colliding ids take the union of their terms rather than letting
   * whichever folder was read last decide.
   */
  async keywords(tabId: string): Promise<Map<string, readonly string[]>> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return new Map();

    const checkouts = tab.project.worktreeOf
      ? []
      : (await this.worktrees.list(tabId).catch(() => [])).filter(
          (w) => !w.bare && !w.current && !w.prunable,
        );
    const paths = [tab.project.path, ...checkouts.map((w) => w.path)];
    const lists = await Promise.all(
      paths.map((path) => this.transcriptStore.keywords(path).catch(() => [])),
    );

    const index = new Map<string, readonly string[]>();
    for (const entry of lists.flat()) {
      const known = index.get(entry.id);
      index.set(
        entry.id,
        known ? [...new Set([...known, ...entry.keywords])] : entry.keywords,
      );
    }
    return index;
  }

  async open(tabId: string, item: HistoryItem): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab || tab.busy) return;
    // Only a row from ANOTHER checkout travels. This tab's own sessions
    // open here, badge or no badge — on a worktree's tab they carry one.
    if (item.from?.elsewhere) {
      await this.openInWorktree(tabId, item, item.from);
      return;
    }
    if (item.native) {
      await this.openNative(tabId, item);
    } else {
      await this.openLocal(tabId, item.id);
    }
  }

  /**
   * A session had in another checkout opens where it belongs: its own
   * worktree tab, brought back when it was closed and simply activated
   * when it was not. Loading it into THIS tab would point an agent
   * confined to the main checkout at a conversation about files it
   * cannot reach.
   *
   * The transcript paints; the agent starts fresh. Resuming with the
   * agent's own memory needs its native listing, which only that tab
   * can ask for — and its History panel offers exactly that, one click
   * away, once you are there.
   */
  private async openInWorktree(
    tabId: string,
    item: HistoryItem,
    from: SessionOrigin,
  ): Promise<void> {
    const tab = tabById(this.store.getState(), tabId)!;
    const mainPath = tab.project.worktreeOf ?? tab.project.path;
    await this.worktrees.open(from.path, mainPath, tabId);

    const opened = this.store
      .getState()
      .tabs.find((t) => samePath(t.project.path, from.path));
    // The folder may be gone from under us — git listed it, opening it
    // is what finds out. Nothing to load into a tab that never opened.
    if (!opened || opened.busy) return;
    await this.openLocal(opened.project.id, item.id);
  }

  /** True resume: the agent replays and REMEMBERS the conversation. */
  private async openNative(tabId: string, item: HistoryItem): Promise<void> {
    // Two ids for one conversation: the agent is asked for ITS session,
    // while the transcript keeps being written under OURS. Opening must
    // not mint a third record of the same chat.
    const sessionId = item.providerSessionId ?? item.id;
    const historyId = item.id;
    const state = this.store.getState();
    const tab = tabById(state, tabId)!;
    const { provider, path, model, effort, mcpOverrides } = tab.project;
    const mcpServers = serversForProvider(
      state.settings.mcpServers,
      provider,
      mcpOverrides,
    );

    this.store.dispatch({ type: "chat/cleared", tabId });
    this.store.dispatch({ type: "chat/busyChanged", tabId, busy: true, at: Date.now() });

    // Our own copy of the conversation, when we saved one. It unlocks
    // `session/resume`: the agent attaches its memory WITHOUT the
    // (slow) full replay, because this copy can paint the screen.
    const localCopy = item.local
      ? await this.transcriptStore.load(path, historyId).catch(() => null)
      : null;

    const replay = new ReplayedSession();
    let resumed = true;
    let replayed = true;
    try {
      ({ replayed } = await this.agentGateway.loadNativeSession(
        {
          tabId,
          provider,
          projectPath: path,
          model,
          effort,
          sessionId,
          mcpServers,
          preferResume: localCopy !== null,
        },
        (event) => replay.fold(event),
      ));
      replay.note("Resumed — the agent remembers this conversation.");
    } catch (e) {
      resumed = false;
      replay.note(
        `Could not resume this session: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (resumed) {
      const messages =
        replayed || !localCopy
          ? replay.messages
          : [
              ...localCopy.messages.map((m, index) => ({
                ...m,
                id: `${historyId}-${index}`,
              })),
              ...replay.messages, // the "Resumed" note (and any stragglers)
            ];
      this.store.dispatch({
        type: "chat/transcriptLoaded",
        tabId,
        sessionId: historyId,
        messages,
        plan: replayed ? replay.plan : (localCopy?.plan ?? replay.plan),
        // The tab is on the agent's session now. Recording it is what
        // lets the next save stamp the right id — and so what keeps this
        // conversation ONE row on the next refresh instead of two.
        providerSessionId: sessionId,
      });
      if (replay.usage) {
        this.store.dispatch({ type: "tab/usageUpdated", tabId, ...replay.usage });
      }
      // A session we have no transcript for (started outside this app)
      // gets one now, pinned where it was listed: opening must not
      // reorder history — only sending a message does. When we DO have a
      // copy there is nothing to write: it already holds the
      // conversation and its own timestamp, and writing a second file
      // for the same chat is what filled the panel with duplicates.
      const firstUserMessage = replay.messages.find((m) => m.role === "user");
      if (replayed && !localCopy)
        void this.transcriptStore
          .save(tab.project.path, {
            id: historyId,
            title: (firstUserMessage?.text ?? "Untitled").slice(0, 80),
            savedAt: item.savedAt,
            provider,
            projectPath: path,
            providerSessionId: sessionId,
            messages: replay.messages,
            plan: replay.plan.length > 0 ? replay.plan : undefined,
          })
          .catch(() => undefined); // the pin is best-effort, like all history
    } else {
      // A resume that failed must not leave the tab claiming that session.
      for (const message of replay.messages) {
        this.store.dispatch({ type: "chat/messageAppended", tabId, message });
      }
    }
    this.store.dispatch({ type: "chat/busyChanged", tabId, busy: false });
  }

  /** Fallback: our own transcript copy (view only, no agent memory). */
  private async openLocal(tabId: string, sessionId: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId)!;
    const transcript = await this.transcriptStore
      .load(tab.project.path, sessionId)
      .catch(() => null);
    if (!transcript) return;

    const messages = transcript.messages.map((m, index) => ({
      ...m,
      id: `${sessionId}-${index}`,
    }));
    // The plan is stored as a PATH — read the content back from disk.
    const planMarkdown = transcript.planFilePath
      ? await this.transcriptStore
          .readPlanFile(tab.project.path, transcript.planFilePath)
          .catch(() => null)
      : null;

    this.store.dispatch({
      type: "chat/transcriptLoaded",
      tabId,
      sessionId,
      messages: [
        ...messages,
        infoMessage(
          "Loaded from history — the agent starts fresh and doesn't have this conversation in memory.",
        ),
      ],
      plan: transcript.plan,
      planMarkdown: planMarkdown ?? undefined,
    });
    if (transcript.planFilePath && !planMarkdown) {
      this.store.dispatch({
        type: "chat/messageAppended",
        tabId,
        message: infoMessage("This session's plan file no longer exists on disk."),
      });
    }
  }

  /** Start a fresh conversation in this tab. See `startNewChat` — the
   *  same step the context-full bar and the auto-compact policy use. */
  async startNew(tabId: string): Promise<void> {
    await startNewChat(this.store, this.agentGateway, tabId);
  }

  /** Delete the transcript where it lives — the worktree's folder for a
   *  worktree's session, this tab's for its own. */
  async remove(tabId: string, item: HistoryItem): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return;
    const path = item.from?.path ?? tab.project.path;
    await this.transcriptStore.remove(path, item.id).catch(() => undefined);
  }
}

/** Newest first — the order every history list is read in. */
function byNewest<T extends { readonly savedAt: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.savedAt - a.savedAt);
}

/** What a worktree's rows are badged with: its branch, or its folder
 *  when there is no branch to name (a detached HEAD). */
function originLabel(worktree: WorktreeItem): string {
  if (worktree.branch) return worktree.branch;
  const trimmed = worktree.path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1);
}

/**
 * Local transcripts by the provider session id each one covers, so a
 * native listing can find our copy of the same conversation.
 *
 * Transcripts written before that id was recorded are indexed by their
 * own id as a fallback — early builds saved a native session under it,
 * and those files are the duplicates this lookup exists to absorb. The
 * newest wins: a conversation split across several transcripts (by a
 * "new chat", or by an older build) resumes into its latest one.
 */
function transcriptsByProviderSession(
  local: readonly TranscriptMeta[],
): Map<string, TranscriptMeta> {
  const byProviderSession = new Map<string, TranscriptMeta>();
  for (const meta of [...local].sort((a, b) => a.savedAt - b.savedAt)) {
    byProviderSession.set(meta.providerSessionId ?? meta.id, meta);
  }
  return byProviderSession;
}
