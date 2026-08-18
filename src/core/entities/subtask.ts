/**
 * Entities layer — subtasks: a tab on a folder the user already has
 * open, with less authority than the folder's plain tab. The scope
 * grammar and its validation live here; enforcement lives with the
 * backend drivers. Pure string work; nothing here touches a disk.
 */

/**
 * How far a subtask's agent may go.
 *
 * - `read-only`: reading the folder is all it does.
 * - `boundary`: read anywhere in the folder, write only inside the
 *   listed sub-folders — a monorepo corner still sees the shared code
 *   it imports.
 */
export type SubtaskAccess = "read-only" | "boundary";

/** The authority one subtask tab grants its agent. */
export interface SubtaskScope {
  readonly access: SubtaskAccess;
  /** Repository-relative folders the agent may write inside (`boundary` only). */
  readonly boundaries?: readonly string[];
}

/**
 * Why this folder cannot be a write boundary, or undefined when it can.
 * A boundary names a folder inside the project, so anything reaching
 * outside one — or into git's own bookkeeping — is refused here rather
 * than at the filesystem. Mirrors `provisionPathProblem`.
 */
export function boundaryPathProblem(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return "Needs a folder inside the project.";
  if (/^([\\/]|[A-Za-z]:)/.test(trimmed)) {
    return "Must be relative to the project, not an absolute path.";
  }
  const segments = trimmed.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.includes("..")) return "Cannot step outside the project with '..'.";
  if (segments[0] === ".git") return "Git's own folder is never a write boundary.";
  return undefined;
}

/**
 * The boundary list as it should be stored: separators normalised,
 * trailing slashes gone, blanks dropped, and folders that name the same
 * place kept once. Case-insensitive dedup for the same reason as
 * `samePath` — the dominant platform's filesystems are.
 */
export function normalizedBoundaries(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const entry of raw) {
    const folder = normalizeBoundary(entry);
    if (!folder) continue;
    const key = folder.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(folder);
  }
  return kept;
}

function normalizeBoundary(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Why this scope cannot be used, or undefined when it can. */
export function subtaskScopeProblem(scope: SubtaskScope): string | undefined {
  if (scope.access === "read-only") return undefined;
  const boundaries = scope.boundaries ?? [];
  if (boundaries.length === 0) return "A boundary subtask needs at least one folder.";
  for (const path of boundaries) {
    const problem = boundaryPathProblem(path);
    if (problem) return problem;
  }
  return undefined;
}

/**
 * True when two scopes grant the same authority. Boundary folders are
 * compared as folders — separator- and case-insensitive, unordered —
 * so an edit that only re-spells a path never respawns a session.
 */
export function sameScope(a?: SubtaskScope, b?: SubtaskScope): boolean {
  if (!a || !b) return a === b || (!a && !b);
  if (a.access !== b.access) return false;
  const keysOf = (scope: SubtaskScope) =>
    normalizedBoundaries(scope.boundaries ?? [])
      .map((f) => f.toLowerCase())
      .sort();
  const ka = keysOf(a);
  const kb = keysOf(b);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i]);
}

/** The scope as a tooltip or row subtitle says it. */
export function describeScope(scope: SubtaskScope): string {
  return scope.access === "read-only"
    ? "read-only"
    : `writes limited to ${(scope.boundaries ?? []).join(", ")}`;
}

/**
 * A named set of write boundaries, saved on the project so the areas of
 * a monorepo are described once rather than re-picked per subtask.
 */
export interface BoundaryPreset {
  readonly id: string;
  /** What the user calls this area — "Frontend", "API". */
  readonly name: string;
  readonly boundaries: readonly string[];
}

/** The longest preset name worth storing; the rows ellipsise well before. */
export const MAX_PRESET_NAME_LENGTH = 40;

/** Why this preset cannot be saved, or undefined when it can. */
export function presetProblem(preset: BoundaryPreset): string | undefined {
  if (!preset.name.trim()) return "Needs a name.";
  return subtaskScopeProblem({ access: "boundary", boundaries: preset.boundaries });
}

/** The preset as it should be stored: name trimmed, folders cleaned up. */
export function normalizedPreset(preset: BoundaryPreset): BoundaryPreset {
  return {
    id: preset.id,
    name: preset.name.trim().slice(0, MAX_PRESET_NAME_LENGTH),
    boundaries: normalizedBoundaries(preset.boundaries),
  };
}

/** The scope a preset stands for — what applying one selects. */
export function presetScope(preset: BoundaryPreset): SubtaskScope {
  return { access: "boundary", boundaries: normalizedBoundaries(preset.boundaries) };
}

/**
 * Presets as they come off disk (or back from an agent's suggestion):
 * every entry validated, unusable ones dropped. Unlike a scope these
 * fail OPEN — a preset is a convenience, not a restriction, so a broken
 * one is simply not offered. Absent stays absent.
 */
export function restoredBoundaryPresets(raw: unknown): BoundaryPreset[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const presets = raw
    .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
    .map((p) => ({
      id: typeof p.id === "string" ? p.id : "",
      name: typeof p.name === "string" ? p.name : "",
      boundaries: Array.isArray(p.boundaries)
        ? p.boundaries.filter((b): b is string => typeof b === "string")
        : [],
    }))
    .map(normalizedPreset)
    .filter((p) => p.id !== "" && !presetProblem(p));
  return presets.length > 0 ? presets : undefined;
}

/**
 * A scope as it comes off disk. Fails closed: a malformed scope was
 * still a decision to restrict this tab, so it degrades to read-only —
 * dropping the field would silently grant full write instead. Absent
 * stays absent: that is an ordinary tab, not a broken subtask.
 */
export function restoredSubtaskScope(raw: unknown): SubtaskScope | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") return { access: "read-only" };
  const scope = raw as { access?: unknown; boundaries?: unknown };
  if (scope.access === "read-only") return { access: "read-only" };
  if (scope.access === "boundary" && Array.isArray(scope.boundaries)) {
    const boundaries = normalizedBoundaries(
      scope.boundaries.filter((b): b is string => typeof b === "string"),
    ).filter((b) => !boundaryPathProblem(b));
    if (boundaries.length > 0) return { access: "boundary", boundaries };
  }
  return { access: "read-only" };
}
