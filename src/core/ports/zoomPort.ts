/**
 * Ports layer — scaling the whole interface, the way a browser's own
 * zoom does. Not a CSS concern: viewport units, hairline borders and
 * device pixel ratio all have to move with it, and only the webview
 * itself knows how.
 */
export interface ZoomPort {
  /** Scale the interface. 1 is untouched. */
  apply(factor: number): Promise<void>;
}
