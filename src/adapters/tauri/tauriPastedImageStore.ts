import { invoke } from "@tauri-apps/api/core";
import type { PastedImageStore } from "../../core/ports/workspacePort";

/**
 * Interface adapter — hands pasted image bytes to the Tauri backend,
 * which writes them under the system temp folder. The returned path then
 * travels like any picked file.
 */
export class TauriPastedImageStore implements PastedImageStore {
  async saveImage(bytes: Uint8Array, mimeType: string): Promise<string> {
    return invoke("save_pasted_image", { data: toBase64(bytes), mimeType });
  }
}

/** btoa wants a binary string; build it in chunks so a large screenshot
 *  never overflows the spread's argument limit. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
