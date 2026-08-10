import { invoke } from "@tauri-apps/api/core";
import type { ShellHistorySource } from "../../core/ports/shellHistorySource";

/**
 * Adapter — the shell's own history file, via the backend. Read once
 * per app run and never written: the shell maintains it itself.
 */
export class TauriShellHistory implements ShellHistorySource {
  async recent(): Promise<readonly string[]> {
    return invoke<string[]>("shell_history");
  }
}
