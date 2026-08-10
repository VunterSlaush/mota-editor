import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { ZoomPort } from "../../core/ports/zoomPort";

/** Interface adapter — the webview's own zoom, as Ctrl+= would drive it. */
export class TauriZoom implements ZoomPort {
  async apply(factor: number): Promise<void> {
    await getCurrentWebview().setZoom(factor);
  }
}
