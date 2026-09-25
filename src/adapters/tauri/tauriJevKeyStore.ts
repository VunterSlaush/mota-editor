import { invoke } from "@tauri-apps/api/core";
import type { JevKeyStatus, JevKeyStore } from "../../core/ports/jevKeyStore";

/** Interface adapter — the Jev key lives in a Rust-owned file (ADR-0025). */
export class TauriJevKeyStore implements JevKeyStore {
  status(): Promise<JevKeyStatus> {
    return invoke<JevKeyStatus>("jev_key_status");
  }

  async setKey(key: string): Promise<void> {
    await invoke("set_jev_api_key", { key });
  }

  async clearKey(): Promise<void> {
    await invoke("clear_jev_api_key");
  }
}
