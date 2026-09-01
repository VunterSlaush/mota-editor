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
  return desktopAction("open_path", projectPath, path);
}

/**
 * UI — hand the file to the OS's "open with" chooser, for when the
 * default app is the wrong one. Windows only: no other desktop exposes
 * its chooser to a command line, and the backend says so rather than
 * opening the default app and pretending it asked.
 */
export async function openFileWith(
  projectPath: string,
  path: string,
): Promise<string | null> {
  return desktopAction("open_path_with", projectPath, path);
}

/**
 * UI — show the file in the OS file manager, selected where the platform
 * can select one and in its folder where it cannot.
 */
export async function revealFile(
  projectPath: string,
  path: string,
): Promise<string | null> {
  return desktopAction("reveal_path", projectPath, path);
}

/** Every one of these hands a project file to the desktop and reports
 *  back the same way: null when it worked, why not when it didn't. */
async function desktopAction(
  command: string,
  projectPath: string,
  path: string,
): Promise<string | null> {
  if (!isTauriRuntime()) return "Opening files needs the desktop app.";
  try {
    await invoke(command, { projectPath, path });
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
