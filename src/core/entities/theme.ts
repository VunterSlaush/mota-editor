/**
 * Entities layer — the selectable color themes. Each is a palette
 * INSPIRED by a well-known editor's default scheme (color values are not
 * copyrightable; no vendor assets are used). The palette itself lives in
 * CSS under `[data-theme="<id>"]`; this file is the catalog the settings
 * screen renders, with a few colors duplicated for the preview swatches.
 */
export interface ThemeInfo {
  readonly id: string;
  readonly label: string;
  /** Where the palette comes from, for the settings screen. */
  readonly hint: string;
  /** Preview swatches: background, text, accent, tool. */
  readonly swatch: readonly [string, string, string, string];
}

export const DEFAULT_THEME = "mota-dark";

export const THEMES: readonly ThemeInfo[] = [
  {
    id: "mota-dark",
    label: "Mota Dark",
    hint: "The app's own look.",
    swatch: ["#14161a", "#e6e8eb", "#4f8cff", "#b58cff"],
  },
  {
    id: "monokai",
    label: "Monokai",
    hint: "In the spirit of Sublime Text.",
    swatch: ["#272822", "#f8f8f2", "#66d9ef", "#ae81ff"],
  },
  {
    id: "dark-plus",
    label: "Dark+",
    hint: "In the spirit of Visual Studio Code (dark).",
    swatch: ["#1e1e1e", "#d4d4d4", "#3794ff", "#c586c0"],
  },
  {
    id: "light-plus",
    label: "Light+",
    hint: "In the spirit of Visual Studio Code (light).",
    swatch: ["#ffffff", "#333333", "#005fb8", "#af00db"],
  },
  {
    id: "one-dark",
    label: "One Dark",
    hint: "In the spirit of Atom.",
    swatch: ["#282c34", "#abb2bf", "#61afef", "#c678dd"],
  },
  {
    id: "one-light",
    label: "One Light",
    hint: "In the spirit of Atom (light).",
    swatch: ["#fafafa", "#383a42", "#4078f2", "#a626a4"],
  },
  {
    id: "brackets",
    label: "Brackets Light",
    hint: "In the spirit of Brackets.",
    swatch: ["#f8f8f8", "#333333", "#1474bf", "#8757ad"],
  },
  {
    id: "darcula",
    label: "Darcula",
    hint: "In the spirit of JetBrains IDEs.",
    swatch: ["#2b2b2b", "#a9b7c6", "#589df6", "#9876aa"],
  },
];

/** Unknown ids (a workspace from a newer build) fall back to the default. */
export function themeById(id: string): ThemeInfo {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
