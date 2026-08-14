import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../adapters/tauri/runtime";

/**
 * UI — open the user extensions folder (`~/.mota/extensions`) in the
 * system file manager. A sibling of `openFileExternally`: an OS verb the
 * settings screen triggers directly, not a port. The backend creates the
 * folder first, so the button works on a fresh install too.
 *
 * Resolves with an error message when the folder can't be opened, so the
 * caller can say so instead of the click doing nothing.
 */
export async function openExtensionsFolder(): Promise<string | null> {
  if (!isTauriRuntime()) return "Opening the folder needs the desktop app.";
  try {
    await invoke("open_extensions_dir");
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
