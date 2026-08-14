/**
 * UI — the webview's reload shortcuts, disarmed.
 *
 * Reload is a browser gesture, and this window is not a browser. A
 * reload drops every live agent session, every running terminal and the
 * whole in-memory transcript on the floor; the workspace file only
 * remembers which projects were open, so what comes back is a shell of
 * what was there. There is no reading of Ctrl+R here that does what the
 * muscle memory expects, which makes doing nothing the least surprising
 * thing it can do.
 *
 * Registered on `window` in the capture phase and before React mounts:
 * the webview runs its own accelerator only when nothing on the page
 * claimed the key first, so this has to be the first handler in the
 * document, not merely one of them. `preventDefault` alone — the event
 * still propagates, leaving the key available should the app ever want
 * to bind it.
 */
export function blockReloadShortcuts(): void {
  window.addEventListener(
    "keydown",
    (event) => {
      if (isReloadShortcut(event)) event.preventDefault();
    },
    { capture: true },
  );
}

/**
 * Every gesture that means "reload": F5 and Ctrl/Cmd+R, plus the
 * cache-busting variants (Ctrl+F5, Ctrl+Shift+R — which arrives as an
 * uppercase `R`) that are the same gesture wearing a modifier.
 */
export function isReloadShortcut(event: KeyboardEvent): boolean {
  if (event.key === "F5") return true;
  return (event.ctrlKey || event.metaKey) && (event.key === "r" || event.key === "R");
}
