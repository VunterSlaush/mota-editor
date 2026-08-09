/**
 * Entities layer — path arithmetic for git worktrees. Pure string work:
 * where a new worktree goes, and when two paths mean the same folder.
 */

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
 * Where a new worktree for `branch` goes: a sibling container next to
 * the main checkout — `<parent>/<repo>-worktrees/<branch-slug>` — so
 * worktrees never land inside the repository and stay easy to find.
 * Collisions with already-known worktrees get a numeric suffix; a
 * residual on-disk collision is left for git to refuse.
 */
export function deriveWorktreePath(
  repoPath: string,
  branch: string,
  takenPaths: readonly string[],
): string {
  const sep = repoPath.includes("\\") ? "\\" : "/";
  const trimmed = repoPath.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const parent = cut > 0 ? trimmed.slice(0, cut) : trimmed;
  const repoName = trimmed.slice(cut + 1) || "repo";
  const slug = sanitizeBranchForPath(branch) || "worktree";

  const base = `${parent}${sep}${repoName}-worktrees${sep}${slug}`;
  let candidate = base;
  for (let n = 2; takenPaths.some((taken) => samePath(taken, candidate)); n += 1) {
    candidate = `${base}-${n}`;
  }
  return candidate;
}
