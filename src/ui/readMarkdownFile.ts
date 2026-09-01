import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../adapters/tauri/runtime";

/** The file's text, or why it could not be shown. */
export type MarkdownFile =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly message: string };

/**
 * UI — read one of the project's markdown files so the app can render it
 * itself. A sibling of `openFileExternally`: that one hands a file to the
 * OS, this one brings it back (ADR-0019).
 *
 * The backend re-checks that the path really is inside the project and
 * really is markdown; nothing here is a permission check.
 */
export async function readMarkdownFile(
  projectPath: string,
  path: string,
): Promise<MarkdownFile> {
  if (!isTauriRuntime())
    return { ok: false, message: "Reading files needs the desktop app." };
  try {
    const text = await invoke<string>("read_project_markdown", { projectPath, path });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
