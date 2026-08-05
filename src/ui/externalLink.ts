import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../adapters/tauri/runtime";

/**
 * UI — open a link from rendered markdown OUTSIDE the app. The webview
 * is a chromeless window with no address bar or back button; navigating
 * it to an agent-supplied URL would hand the whole window to that page.
 * Only web-ish schemes are let through (react-markdown already strips
 * `javascript:` and friends; this is the second gate).
 */
export function openExternalLink(url: string): void {
  if (!/^(https?:\/\/|mailto:)/i.test(url)) return;
  if (isTauriRuntime()) {
    void invoke("open_external", { url }).catch(() => undefined);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
