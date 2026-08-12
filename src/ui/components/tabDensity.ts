/** How much of a tab there is room to show. */
export type TabDensity = "full" | "compact" | "icons";

/** The "+" button and the strip's padding, which are not the tabs'. */
const RESERVED_PX = 44;

/** Below this a branch is not worth the width it takes from the name. */
const BRANCH_NEEDS_PX = 150;

/** Below this a name is down to two characters and an ellipsis, which
 *  says less than the icon beside it already does. */
const NAME_NEEDS_PX = 92;

/**
 * What each tab can afford to show, given the strip's width and how many
 * tabs are sharing it — the browser rule: tabs shrink together, and drop
 * what they are showing rather than overflowing the window.
 *
 * A width of zero means nothing has been measured yet, which is not the
 * same as no room: the strip would otherwise open as bare icons for a
 * frame and then flash back into names.
 */
export function tabDensity(barWidth: number, tabCount: number): TabDensity {
  if (barWidth <= 0 || tabCount === 0) return "full";
  const each = (barWidth - RESERVED_PX) / tabCount;
  if (each >= BRANCH_NEEDS_PX) return "full";
  if (each >= NAME_NEEDS_PX) return "compact";
  return "icons";
}
