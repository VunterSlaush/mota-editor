/**
 * Entities layer — the palette a tab can be marked with, for grouping the
 * tabs that belong to one task.
 *
 * Ids only. The values live in CSS as `--tab-color-<id>`, the same split
 * `theme.ts` uses, so a colour is drawn in terms of the theme around it
 * instead of being pinned to one palette.
 */
export type TabColorId = "red" | "amber" | "green" | "teal" | "blue" | "violet" | "grey";

export interface TabColorInfo {
  readonly id: TabColorId;
  readonly label: string;
}

/** Every colour, in the order the swatches offer them. */
export const TAB_COLORS: readonly TabColorInfo[] = [
  { id: "red", label: "Red" },
  { id: "amber", label: "Amber" },
  { id: "green", label: "Green" },
  { id: "teal", label: "Teal" },
  { id: "blue", label: "Blue" },
  { id: "violet", label: "Violet" },
  { id: "grey", label: "Grey" },
];

/**
 * Whether a stored string still names a colour. The workspace file is
 * untrusted input: a colour a newer build wrote must leave the tab
 * uncoloured rather than resolve to a CSS variable that does not exist.
 */
export function isTabColorId(value: string): value is TabColorId {
  return TAB_COLORS.some((color) => color.id === value);
}
