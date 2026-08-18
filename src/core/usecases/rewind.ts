import { describeStat, isUnchanged, rewindNotice } from "../entities/checkpoint";
import { infoMessage } from "../entities/message";
import type { CheckpointPort, CheckpointPreview } from "../ports/checkpointPort";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/**
 * Use case — put the project's files back the way they were before an
 * earlier prompt.
 *
 * Only files. The conversation is deliberately left alone: truncating it
 * would desync Mota's transcript from the agent's own memory, which the
 * ACP adapters give us no way to rewind. The transcript notice says so
 * in as many words, because an agent that still believes it made those
 * edits is the one way this can mislead.
 */
export class Rewind {
  constructor(
    private readonly store: Store,
    private readonly checkpoints: CheckpointPort,
  ) {}

  /** What rewinding here would change, for the confirm dialog. */
  async preview(tabId: string, checkpoint: string): Promise<CheckpointPreview | null> {
    const path = this.projectPath(tabId);
    if (!path) return null;
    try {
      return await this.checkpoints.preview(path, checkpoint);
    } catch {
      // A checkpoint whose objects are gone (someone ran `git gc
      // --prune=now`, or the folder stopped being a repository). Nothing
      // to show and nothing to restore — the caller surfaces the empty.
      return null;
    }
  }

  /** One file's diff, checkpoint versus now. */
  async fileDiff(tabId: string, checkpoint: string, path: string): Promise<string> {
    const project = this.projectPath(tabId);
    if (!project) return "";
    return this.checkpoints.fileDiff(project, checkpoint, path);
  }

  /**
   * Do it. Takes its own checkpoint first so the rewind is itself
   * undoable — the single most valuable thing this can do for someone
   * who has just rewound one turn too far.
   */
  async execute(tabId: string, checkpoint: string): Promise<void> {
    const path = this.projectPath(tabId);
    if (!path) return;

    const preview = await this.preview(tabId, checkpoint);
    if (!preview || isUnchanged(preview.stat)) {
      this.store.dispatch({ type: "rewind/pickerToggled", tabId, open: false });
      this.store.dispatch({
        type: "chat/messageAppended",
        tabId,
        message: infoMessage(
          preview
            ? rewindNotice(preview.stat)
            : "That checkpoint is no longer available.",
        ),
      });
      return;
    }

    // Before the first file is written, not after: an undo point taken
    // afterwards would snapshot the rewound tree and undo nothing.
    const undo = await this.checkpoints.create(path, undoSessionId(tabId));

    try {
      await this.checkpoints.restore(path, checkpoint);
    } catch (error) {
      this.store.dispatch({ type: "rewind/pickerToggled", tabId, open: false });
      this.store.dispatch({
        type: "chat/messageAppended",
        tabId,
        message: infoMessage(`Rewind failed: ${message(error)}`),
      });
      return;
    }

    this.store.dispatch({
      type: "rewind/done",
      tabId,
      summary: describeStat(preview.stat),
      undo,
    });
    this.store.dispatch({
      type: "chat/messageAppended",
      tabId,
      message: infoMessage(rewindNotice(preview.stat)),
    });
  }

  /** Put back what the last rewind took away. */
  async undo(tabId: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab?.rewound) return;
    const undo = tab.rewound.undo;
    this.store.dispatch({ type: "rewind/dismissed", tabId });
    await this.execute(tabId, undo);
  }

  private projectPath(tabId: string): string | undefined {
    return tabById(this.store.getState(), tabId)?.project.path;
  }
}

/**
 * Undo points hang from their own ref rather than the conversation's, so
 * dropping a chat's checkpoints can never take away the undo for a
 * rewind the user has not yet decided to keep.
 */
function undoSessionId(tabId: string): string {
  return `${tabId}-undo`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
