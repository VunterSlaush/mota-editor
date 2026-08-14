import type { ExtensionCommandHit } from "../entities/extension";
import { parseExtensionActions } from "../entities/extensionActions";
import { errorMessage, infoMessage } from "../entities/message";
import type { ExtensionHostPort } from "../ports/extensionHost";
import type { NotificationPort } from "../ports/notificationPort";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/**
 * Use case — run a PROGRAMMATIC extension command and act on what it
 * returns. The action vocabulary is deliberately the app's own verbs
 * (notify, edit the draft, start a turn), each checked against the
 * extension's granted permissions here as well — the Rust broker guards
 * the wire, this guards the action route.
 */
export class RunExtensionCommand {
  /** Late-bound: SendPrompt routes commands here and `startTurn` goes
   *  back through SendPrompt — the composition root ties the knot. */
  private startTurn: ((tabId: string, prompt: string) => Promise<void>) | null = null;

  constructor(
    private readonly store: Store,
    private readonly extensionHost: ExtensionHostPort,
    private readonly notifications: NotificationPort,
  ) {}

  connectTurnStarter(startTurn: (tabId: string, prompt: string) => Promise<void>): void {
    this.startTurn = startTurn;
  }

  async execute(tabId: string, hit: ExtensionCommandHit, args: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return;

    let raw: unknown;
    try {
      raw = await this.extensionHost.invokeCommand(
        hit.extension.id,
        hit.command.name,
        args,
        tabId,
        tab.project.path,
      );
    } catch (e) {
      this.store.dispatch({
        type: "chat/messageAppended",
        tabId,
        message: errorMessage(
          `Extension ${hit.extension.displayName} failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        ),
      });
      return;
    }

    const permissions = hit.extension.permissions;
    for (const action of parseExtensionActions(raw)) {
      switch (action.type) {
        case "notify":
          if (permissions.includes("notifications")) {
            await this.notifications
              .show(action.title, action.message)
              .catch(() => undefined);
          }
          break;
        case "insertPrompt":
          this.store.dispatch({
            type: "chat/draftChanged",
            tabId,
            draft: action.text,
            attachments: [],
          });
          break;
        case "startTurn":
          if (permissions.includes("agent:prompt") && this.startTurn) {
            await this.startTurn(tabId, action.prompt);
          } else {
            this.store.dispatch({
              type: "chat/messageAppended",
              tabId,
              message: infoMessage(
                `${hit.extension.displayName} asked to start a turn without the agent:prompt permission.`,
              ),
            });
          }
          break;
      }
    }
  }
}
