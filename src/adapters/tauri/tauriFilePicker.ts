import { open } from "@tauri-apps/plugin-dialog";
import type { FilePicker } from "../../core/ports/workspacePort";

/** Interface adapter — native multi-file picker via the Tauri plugin. */
export class TauriFilePicker implements FilePicker {
  async pickFiles(): Promise<string[]> {
    const selection = await open({ directory: false, multiple: true });
    if (Array.isArray(selection)) return selection;
    return typeof selection === "string" ? [selection] : [];
  }
}
