import type { Store } from "../state/store";

/**
 * Use case — the half-written prompt for a project tab.
 *
 * It lives in app state rather than in the composer because switching
 * tabs remounts the chat view, which would otherwise throw the user's
 * unsent text away. Deliberately NOT persisted to the workspace file: a
 * draft is worth keeping for the session, not worth a disk write per
 * keystroke.
 */
export class EditDraft {
  constructor(private readonly store: Store) {}

  execute(tabId: string, draft: string, attachments: readonly string[]): void {
    this.store.dispatch({ type: "chat/draftChanged", tabId, draft, attachments });
  }
}
