import { open } from "@tauri-apps/plugin-dialog";
import type { FolderPicker } from "../../core/ports/workspacePort";

/** Interface adapter — native folder-picker dialog via the Tauri plugin. */
export class TauriFolderPicker implements FolderPicker {
  async pickFolder(): Promise<string | null> {
    const selection = await open({ directory: true, multiple: false });
    return typeof selection === "string" ? selection : null;
  }
}
