import { type Project, tabLabel } from "../../core/entities/project";

/**
 * What each tab is called in the strip, numbered where two of them would
 * otherwise read exactly the same.
 *
 * A duplicate is the case that needs it: same folder as its source, same
 * branch chip, so without a number the two are indistinguishable. Two
 * worktrees whose folders share a name, or two tabs the user gave one
 * name to, have the same problem and get the same answer.
 *
 * The first of a set keeps its plain name, so a number always means "not
 * the first of these" — and closing that first tab gives the plain name
 * back to whichever is now first.
 */
export function tabStripLabels(projects: readonly Project[]): readonly string[] {
  const seen = new Map<string, number>();
  return projects.map((project) => {
    const name = tabLabel(project);
    const before = seen.get(name) ?? 0;
    seen.set(name, before + 1);
    return before === 0 ? name : `${name} (${before + 1})`;
  });
}
