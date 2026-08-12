/**
 * Entities layer — what a programmatic extension command may ask the
 * workbench to do. The extension process answers `command/execute` with
 * a list of these; anything unrecognized is dropped, never guessed at
 * (the same drift posture as the wire protocols).
 */
export type ExtensionAction =
  | { readonly type: "notify"; readonly title: string; readonly message: string }
  | { readonly type: "insertPrompt"; readonly text: string }
  | { readonly type: "startTurn"; readonly prompt: string };

const MAX_ACTIONS = 10;
const MAX_TEXT = 20_000;

/**
 * Validate a raw `command/execute` result into actions. Extensions are
 * outside processes — their output is input, and input gets checked.
 */
export function parseExtensionActions(raw: unknown): ExtensionAction[] {
  if (typeof raw !== "object" || raw === null) return [];
  const list = (raw as { actions?: unknown }).actions;
  if (!Array.isArray(list)) return [];

  const actions: ExtensionAction[] = [];
  for (const entry of list.slice(0, MAX_ACTIONS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    switch (item.type) {
      case "notify":
        if (typeof item.title === "string" && typeof item.message === "string") {
          actions.push({
            type: "notify",
            title: item.title.slice(0, 200),
            message: item.message.slice(0, 1000),
          });
        }
        break;
      case "insertPrompt":
        if (typeof item.text === "string") {
          actions.push({ type: "insertPrompt", text: item.text.slice(0, MAX_TEXT) });
        }
        break;
      case "startTurn":
        if (typeof item.prompt === "string") {
          actions.push({ type: "startTurn", prompt: item.prompt.slice(0, MAX_TEXT) });
        }
        break;
      default:
        break; // Unknown action types are ignored — additive evolution.
    }
  }
  return actions;
}
