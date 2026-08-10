import { type TabStatus, tabStatus } from "./tabStatus";

/**
 * Entities layer — what the taskbar/dock indicator should say for the
 * WHOLE app, distilled from the per-tab indicators.
 *
 * The tab bar answers "which tab needs me?"; this answers the question
 * you have when the window isn't even on screen: "is anything waiting
 * for me over there?". One color and one number is all a taskbar can
 * carry, so the worst state present wins and the number counts the tabs
 * in exactly that state — a badge saying "2" in red means two failures,
 * not two things of which some are failures.
 */

/** Badge states, worst first — the order IS the precedence. */
export const BADGE_LEVELS = ["error", "needsInput", "done", "busy"] as const;

export type BadgeLevel = (typeof BADGE_LEVELS)[number];

export interface AppBadge {
  readonly level: BadgeLevel;
  /** Tabs in `level`; at least 1. */
  readonly count: number;
}

/** The tab fields the badge is derived from — the same ones `tabStatus`
 *  reads, so the two indicators can never disagree. */
type BadgeTab = Parameters<typeof tabStatus>[0];

/**
 * The badge for these tabs, or null when nothing is worth interrupting
 * for.
 *
 * Ranked, not summed: `error` outranks `needsInput` because a failure is
 * the thing you would want to know first, and `busy` comes last because
 * "still working" is the one state that resolves without you.
 */
export function appBadge(tabs: readonly BadgeTab[]): AppBadge | null {
  const counts = new Map<TabStatus, number>();
  for (const tab of tabs) {
    const status = tabStatus(tab);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  for (const level of BADGE_LEVELS) {
    const count = counts.get(level) ?? 0;
    if (count > 0) return { level, count };
  }
  return null;
}

/** Whether two badges say the same thing — the port is only called when
 *  they don't, so an idle app makes no IPC calls at all. */
export function sameBadge(a: AppBadge | null, b: AppBadge | null): boolean {
  if (a === null || b === null) return a === b;
  return a.level === b.level && a.count === b.count;
}
