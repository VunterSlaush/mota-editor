import { describe, expect, it } from "vitest";
import { isTabColorId, TAB_COLORS } from "./tabColor";

describe("tab colours", () => {
  it("recognises every colour in the palette", () => {
    expect(TAB_COLORS).toHaveLength(7);
    for (const color of TAB_COLORS) {
      expect(isTabColorId(color.id)).toBe(true);
    }
  });

  it("does not recognise a colour this build has never had", () => {
    // A workspace file from a newer build, or edited by hand: the tab must
    // end up uncoloured, not pointing at a CSS variable that isn't there.
    expect(isTabColorId("chartreuse")).toBe(false);
    expect(isTabColorId("")).toBe(false);
  });
});
