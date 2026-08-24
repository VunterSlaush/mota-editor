/** The build's version, from package.json, defined by Vite at build time. */
declare const __APP_VERSION__: string;

/**
 * UI helper — what to call this build, shown beside the app's name and in
 * Settings. A constant, not a question for the backend: the browser
 * preview has no backend to ask, and a version that arrives a frame late
 * is a version that flickers.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";
