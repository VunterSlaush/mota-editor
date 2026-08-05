import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../adapters/tauri/runtime";

/**
 * UI — open one of the project's files in whatever editor the OS has
 * associated with it. A sibling of `openExternalLink`, kept separate
 * because that one's scheme allowlist exists to keep local paths out;
 * the backend re-checks that this path really is inside the project.
 *
 * Resolves with an error message when the file can't be opened, so the
 * caller can say so instead of the click doing nothing.
 */
export async function openFileExternally(
  projectPath: string,
  path: string,
): Promise<string | null> {
  if (!isTauriRuntime()) return "Opening files needs the desktop app.";
  try {
    await invoke("open_path", { projectPath, path });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
