/**
 * Entities — a project's file list, shaped into the tree the sidebar draws.
 *
 * The listing arrives flat ("src/ui/App.tsx"), which is what the agent and
 * the "@" menu want, and what git hands over. Folding it into folders is a
 * display concern with no I/O in it at all, so it lives here and is tested
 * without a browser.
 *
 * Building the tree and choosing which rows are on screen are separate on
 * purpose: the fold-and-sort is the expensive half and depends only on the
 * paths, so opening a folder never re-sorts the project.
 */

/** A folder or a file. Folders are the nodes that have children — git never
 *  lists an empty folder, so there is no third state to tell apart. */
export interface FileTreeNode {
  /** Project-relative, forward slashes, as the listing gave it. */
  readonly path: string;
  /** The last segment — what the row shows. */
  readonly name: string;
  /** Folders first, then by name; see `compare`. */
  readonly children: readonly FileTreeNode[];
}

/** One line of the panel. `depth` is indentation, not information. */
export interface FileRow {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly isDirectory: boolean;
}

/**
 * The paths folded into a sorted tree.
 *
 * Only "/" separates: the listing is git's, which speaks forward slashes on
 * every platform, and a backslash is a legal character in a file name —
 * splitting on it would invent a folder that is not there.
 */
export function buildFileTree(paths: readonly string[]): readonly FileTreeNode[] {
  const root = newFolder();
  for (const path of paths) {
    insert(root, path);
  }
  return sorted(root);
}

/**
 * The rows to draw, top to bottom, given the folders the user has opened.
 *
 * A folder nobody opened is never descended into, so a collapsed branch
 * costs nothing and an `expanded` entry naming a folder that has since been
 * deleted is simply never reached.
 */
export function visibleRows(
  nodes: readonly FileTreeNode[],
  expanded: ReadonlySet<string>,
): readonly FileRow[] {
  const rows: FileRow[] = [];
  collect(nodes, expanded, 0, rows);
  return rows;
}

/**
 * What a file is, as far as the tree cares: enough to pick a glyph and a
 * colour for its row, and no more. Several spellings of one language
 * collapse into one kind, and anything unrecognised is `plain` — a tree
 * that guessed wrong would be worse than a tree that stayed quiet.
 */
export type FileKind =
  | "ts"
  | "tsx"
  | "js"
  | "jsx"
  | "style"
  | "markup"
  | "data"
  | "rust"
  | "python"
  | "markdown"
  | "text"
  | "image"
  | "plain";

const KIND_BY_EXTENSION: Readonly<Record<string, FileKind>> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  css: "style",
  scss: "style",
  sass: "style",
  less: "style",
  html: "markup",
  htm: "markup",
  vue: "markup",
  svelte: "markup",
  xml: "markup",
  json: "data",
  yaml: "data",
  yml: "data",
  toml: "data",
  sql: "data",
  csv: "data",
  rs: "rust",
  py: "python",
  md: "markdown",
  markdown: "markdown",
  txt: "text",
  log: "text",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  svg: "image",
  webp: "image",
  ico: "image",
};

/** The kind of the file a row shows, from its name alone. */
export function fileKind(name: string): FileKind {
  const cut = name.lastIndexOf(".");
  // A leading dot is the whole name of a `.gitignore`, not an extension:
  // reading it as one would file it under a language it is not.
  if (cut <= 0) return "plain";
  return KIND_BY_EXTENSION[name.slice(cut + 1).toLowerCase()] ?? "plain";
}

/**
 * Whether this app shows the file itself rather than handing it to the OS.
 *
 * Markdown only, and for one reason: the renderer is already here, shipped
 * for agent output, so showing a README costs nothing but a modal. Every
 * other kind still leaves — the OS knows which app opens a `.ts`, and
 * carrying an editor is the thing this app is not (ADR-0019).
 */
export function rendersInApp(name: string): boolean {
  return fileKind(name) === "markdown";
}

/** A folder while it is still being built: children by name, order later. */
interface Builder {
  readonly children: Map<string, Builder>;
}

function newFolder(): Builder {
  return { children: new Map() };
}

function insert(root: Builder, path: string): void {
  let folder = root;
  // Empty segments come from "", "a//b.ts" and a trailing slash; a nameless
  // row would be unclickable and un-keyable, so they are skipped rather
  // than allowed to become nodes.
  for (const segment of path.split("/")) {
    if (segment === "") continue;
    const child = folder.children.get(segment) ?? newFolder();
    folder.children.set(segment, child);
    folder = child;
  }
}

function sorted(folder: Builder, prefix = ""): readonly FileTreeNode[] {
  const nodes: FileTreeNode[] = [];
  for (const [name, child] of folder.children) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    nodes.push({ path, name, children: sorted(child, path) });
  }
  return nodes.sort(compare);
}

/** Folders first — the shape of the project reads before its contents —
 *  then by name, with case ignored the way a file manager ignores it. A
 *  name that differs only by case still has to land somewhere definite, or
 *  the tree would shuffle between one platform and the next. */
function compare(a: FileTreeNode, b: FileTreeNode): number {
  const byKind = Number(b.children.length > 0) - Number(a.children.length > 0);
  if (byKind !== 0) return byKind;
  const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  if (byName !== 0) return byName;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function collect(
  nodes: readonly FileTreeNode[],
  expanded: ReadonlySet<string>,
  depth: number,
  rows: FileRow[],
): void {
  for (const node of nodes) {
    const isDirectory = node.children.length > 0;
    rows.push({ path: node.path, name: node.name, depth, isDirectory });
    if (isDirectory && expanded.has(node.path)) {
      collect(node.children, expanded, depth + 1, rows);
    }
  }
}
