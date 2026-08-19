import { tabIsWorking } from "../entities/tabStatus";
import type { AgentGateway } from "../ports/agentGateway";
import type { ShellPort } from "../ports/shellPort";
import type { WorkspaceStore } from "../ports/workspacePort";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import { persistWorkspace } from "./persistWorkspace";
import type { RetiredChats } from "./retiredChats";

/**
 * Use case — close a project tab, tearing down its agent session (which
 * also stops any turn still running) and the terminals the user opened
 * in it.
 */
export class CloseProject {
  constructor(
    private readonly store: Store,
    private readonly agentGateway: AgentGateway,
    private readonly workspaceStore: WorkspaceStore,
    private readonly shells: ShellPort,
    private readonly retiredChats?: RetiredChats,
  ) {}

  /**
   * Whether closing this tab would throw work away — a turn running, or
   * prompts queued behind it. A query, so the view can ask before it
   * commits; `execute` still closes whatever the answer was, because by
   * then the decision has been made.
   */
  needsConfirmation(tabId: string): boolean {
    const tab = tabById(this.store.getState(), tabId);
    return tab !== null && tabIsWorking(tab);
  }

  async execute(tabId: string): Promise<void> {
    // Terminals first: on Windows a live shell holds a handle on its
    // working directory, and removing a worktree closes its tab before
    // trying to delete the folder.
    await this.shells.closeProject(tabId).catch(() => undefined);
    await this.agentGateway.cancelTurn(tabId).catch(() => undefined);
    // Ends the tab's retired agent too, if it had one — so what it had
    // already said is filed first, while there is still a chat to file.
    this.retiredChats?.forget(tabId);
    await this.agentGateway.endSession(tabId).catch(() => undefined);
    this.store.dispatch({ type: "tab/closed", tabId });
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}
