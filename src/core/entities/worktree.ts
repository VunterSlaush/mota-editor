/**
 * Entities layer — git worktrees: the path arithmetic (where a new
 * worktree goes, when two paths mean the same folder) and the settings
 * that steer it. Pure string work; nothing here touches a disk.
 */

import { filterFiles } from "./fileMention";

/**
 * What to do with a heavy folder — `node_modules`, a build target — that
 * git does not carry into a new worktree.
 *
 * - `share`: one copy, linked from every worktree. Correct only for
 *   artifacts the agent never reads: a link resolves outside the
 *   worktree, and the agent's file access is confined to it.
 * - `clone`: a private copy, made with the filesystem's copy-on-write
 *   where it has one (APFS, btrfs, xfs), so it costs almost nothing.
 * - `skip`: leave it out; the user installs or builds as usual.
 */
export type ProvisionStrategy = "share" | "clone" | "skip";

/** One heavy folder and how a new worktree should get it. */
export interface ProvisionEntry {
  /** Repository-relative, e.g. `node_modules`, `src-tauri/target`. */
  readonly path: string;
  readonly strategy: ProvisionStrategy;
}

/** App-wide worktree preferences. */
export interface WorktreeSettings {
  /** Where new worktrees go; empty means the default sibling container. */
  readonly container: string;
  /** The remote assumed for a branch that only exists remotely. */
  readonly remote: string;
  /**
   * Heavy folders a new worktree gets, and how — the app-wide default.
   * A project may carry its own list; see `effectiveProvisioning`.
   */
  readonly provisioning: readonly ProvisionEntry[];
  /** Seed a worktree's tab from the tab it was opened from. */
  readonly inheritFromSourceTab: boolean;
}

/**
 * The list that applies to one project: its own when it set one — an
 * empty list is a real answer, "prepare nothing here" — and the app
 * default otherwise. The same tri-state as a project's MCP overrides.
 */
export function effectiveProvisioning(
  override: readonly ProvisionEntry[] | undefined,
  appDefault: readonly ProvisionEntry[],
): readonly ProvisionEntry[] {
  return override ?? appDefault;
}

/**
 * Nothing is provisioned by default. Which folders are heavy is a
 * property of the repository, not of this app: `node_modules` means
 * nothing to a Go project, and copying it behind someone's back is the
 * kind of surprise a fresh worktree should never spring. The settings
 * section suggests the folders it actually finds on disk instead.
 */
export const defaultWorktreeSettings: WorktreeSettings = {
  container: "",
  remote: "origin",
  provisioning: [],
  inheritFromSourceTab: true,
};

/** Whether a worktree can go, and what to say before it does. */
export interface RemovalCheck {
  /** Git refuses without `--force`, because work would be lost. */
  readonly needsForce: boolean;
  /** Reasons to stop, worst first. Non-empty means "do not just do it". */
  readonly blockers: readonly string[];
  /** Merged, clean and unlocked — the disk is free for the taking. */
  readonly reclaimable: boolean;
}

/** The parts of a worktree this decision reads. */
interface RemovableWorktree {
  readonly main: boolean;
  readonly locked: boolean;
}

/**
 * Read the removal situation from what git already told us: how many
 * files the worktree has changed, its entry in `git worktree list`, and
 * whether its branch is merged.
 *
 * Untracked files count as work — git refuses on them too, and a file
 * nobody added is exactly the kind that exists nowhere else. Ignored
 * files never appear in `git status`, so `node_modules` and a build
 * target can never be what provokes the force prompt.
 */
export function removalCheck(
  changedFiles: number,
  worktree: RemovableWorktree,
  merged: boolean,
): RemovalCheck {
  const blockers: string[] = [];
  if (worktree.main) blockers.push("The main checkout cannot be removed.");
  if (worktree.locked) blockers.push("Locked — unlock it in git first.");
  if (changedFiles > 0) {
    const noun = changedFiles === 1 ? "file" : "files";
    blockers.push(`${changedFiles} uncommitted or untracked ${noun}.`);
  }
  return {
    needsForce: changedFiles > 0,
    blockers,
    reclaimable: merged && changedFiles === 0 && !worktree.locked && !worktree.main,
  };
}

/**
 * Why this folder cannot be prepared, or undefined when it can. A
 * provisioned path names a folder inside the worktree, so anything that
 * reaches outside one — or into git's own bookkeeping — is refused here
 * rather than at the filesystem.
 */
export function provisionPathProblem(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return "Needs a folder before a worktree can be prepared.";
  if (/^([\\/]|[A-Za-z]:)/.test(trimmed)) {
    return "Must be relative to the repository, not an absolute path.";
  }
  const segments = trimmed.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.includes("..")) return "Cannot step outside the worktree with '..'.";
  if (segments[0] === ".git") return "Git's own folder is never prepared.";
  return undefined;
}

/** How many folders the settings suggestion list ever offers. */
export const FOLDER_SUGGESTION_LIMIT = 8;

/**
 * Folder names that are heavy in some ecosystem or other. Only an
 * ordering hint — every folder in the project is still offered, these
 * just come first, because they are what the list exists for.
 */
const LIKELY_HEAVY = [
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".venv",
  "venv",
  "vendor",
  ".gradle",
  "Pods",
];

/**
 * The folders to offer while typing a heavy-folder path: those the
 * project has, minus the ones already listed, matched against what has
 * been typed so far, likely-heavy names first.
 */
export function folderSuggestions(
  candidates: readonly string[],
  typed: string,
  taken: readonly string[],
  limit = FOLDER_SUGGESTION_LIMIT,
): string[] {
  const already = new Set(
    taken.map((p) => p.trim().replace(/\\/g, "/").replace(/\/+$/, "")),
  );
  const free = candidates.filter((path) => !already.has(path));
  const ordered = [...free].sort((a, b) => heaviness(a) - heaviness(b));
  return filterFiles(ordered, typed.trim(), limit);
}

/** Lower sorts first: a likely-heavy leaf beats an ordinary folder. */
function heaviness(path: string): number {
  const leaf = path.slice(path.lastIndexOf("/") + 1);
  return LIKELY_HEAVY.includes(leaf) ? 0 : 1;
}

/** Folders an agent has a real reason to read, by first path segment. */
const READ_BY_AGENTS = ["node_modules", "vendor", ".venv", "site-packages"];

/**
 * Why sharing this folder would hurt, or undefined when it is safe.
 * A shared folder is a link out of the worktree, and the agent's file
 * access is confined to the worktree — so build tools still resolve it
 * but the agent's own reads are refused.
 */
export function shareRisk(path: string): string | undefined {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const hit = segments.find((segment) => READ_BY_AGENTS.includes(segment));
  return hit
    ? `The agent cannot read a linked ${hit}: the symlink leads outside the worktree. Copy it instead.`
    : undefined;
}

/**
 * A branch name as a single path segment: `feature/login` becomes
 * `feature-login`. Anything outside [A-Za-z0-9._-] is a separator on
 * some filesystem, so it is replaced rather than trusted.
 */
export function sanitizeBranchForPath(branch: string): string {
  return branch
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/**
 * True when two absolute paths name the same folder, across the styles
 * this app actually meets: git prints `C:/repos/x`, the OS dialog hands
 * back `C:\repos\x`. Case-insensitive because the dominant platform's
 * filesystems are.
 */
export function samePath(a: string, b: string): boolean {
  return normalize(a) === normalize(b);
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * A free name for a branch forked off `base`: `base-2`, `base-3`, … —
 * the first not already taken. Case-insensitive, because Windows ref
 * files collide case-insensitively.
 */
export function deriveBranchName(base: string, taken: readonly string[]): string {
  const lower = taken.map((t) => t.toLowerCase());
  let n = 2;
  while (lower.includes(`${base.toLowerCase()}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * Where a new worktree for `branch` goes: by default a sibling container
 * next to the main checkout — `<parent>/<repo>-worktrees/<branch-slug>`
 * — so worktrees never land inside the repository and stay easy to
 * find. `container` overrides that folder, for a bigger or faster disk.
 * Collisions with already-known worktrees get a numeric suffix; a
 * residual on-disk collision is left for git to refuse.
 */
export function deriveWorktreePath(
  repoPath: string,
  branch: string,
  takenPaths: readonly string[],
  container?: string,
): string {
  const slug = sanitizeBranchForPath(branch) || "worktree";
  const folder = container?.trim()
    ? container.trim().replace(/[\\/]+$/, "")
    : defaultContainer(repoPath);
  const sep = folder.includes("\\") ? "\\" : "/";

  const base = `${folder}${sep}${slug}`;
  let candidate = base;
  for (let n = 2; takenPaths.some((taken) => samePath(taken, candidate)); n += 1) {
    candidate = `${base}-${n}`;
  }
  return candidate;
}

/** `<parent>/<repo>-worktrees` — shown as the placeholder in settings. */
export function defaultContainer(repoPath: string): string {
  const sep = repoPath.includes("\\") ? "\\" : "/";
  const trimmed = repoPath.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const parent = cut > 0 ? trimmed.slice(0, cut) : trimmed;
  const repoName = trimmed.slice(cut + 1) || "repo";
  return `${parent}${sep}${repoName}-worktrees`;
}
