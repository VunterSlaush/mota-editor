/**
 * Interface adapter — detects whether the UI is running inside the Tauri
 * window (backend available) or a plain browser tab (UI preview only).
 * The only place this environment probe is allowed to live.
 */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
