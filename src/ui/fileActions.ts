import { openFileExternally, openFileWith, revealFile } from "./openFile";
import { type MarkdownFile, readMarkdownFile } from "./readMarkdownFile";

/**
 * UI — everything the Files panel can do to one of the project's files,
 * as one value rather than four props threaded side by side.
 *
 * Each of the first three resolves with an error message when it could
 * not be done, and null when it was, so a failed click can say why
 * instead of doing nothing.
 */
export interface FileActions {
  /** Open in whatever app the OS associates with the file. */
  open: (path: string) => Promise<string | null>;
  /** Open via the OS's "open with" chooser. Windows only — see `canOpenWith`. */
  openWith: (path: string) => Promise<string | null>;
  /** Show the file in the OS file manager. */
  reveal: (path: string) => Promise<string | null>;
  /** Read a markdown file so the app can render it in place (ADR-0019). */
  readMarkdown: (path: string) => Promise<MarkdownFile>;
}

/**
 * Whether this desktop has an "open with" chooser to hand a file to.
 *
 * Windows does; macOS and the Linux desktops keep theirs inside the file
 * manager, out of reach of a command line. Read here so the menu can
 * leave the item out rather than offer one that always fails — the same
 * `userAgent` check the drag and terminal code already make.
 */
export const CAN_OPEN_WITH = navigator.userAgent.includes("Windows");

/** What the OS calls the thing "show in…" opens, so the menu item is
 *  named after the app the user is about to be looking at. */
export function fileManagerName(): string {
  if (navigator.userAgent.includes("Windows")) return "File Explorer";
  if (navigator.userAgent.includes("Mac")) return "Finder";
  return "the file manager";
}

/** The actions bound to one project — the composition the shell does once
 *  per tab, so no component below it needs the project's path. */
export function projectFileActions(projectPath: string): FileActions {
  return {
    open: (path) => openFileExternally(projectPath, path),
    openWith: (path) => openFileWith(projectPath, path),
    reveal: (path) => revealFile(projectPath, path),
    readMarkdown: (path) => readMarkdownFile(projectPath, path),
  };
}
