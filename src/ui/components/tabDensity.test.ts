import { describe, expect, it } from "vitest";
import { tabDensity } from "./tabDensity";

describe("tabDensity", () => {
  it("shows everything when the tabs have room", () => {
    expect(tabDensity(1200, 3)).toBe("full");
  });

  it("drops to names once the branch would not fit", () => {
    expect(tabDensity(600, 5)).toBe("compact");
  });

  it("drops to icons when even a name has nowhere to go", () => {
    expect(tabDensity(600, 12)).toBe("icons");
  });

  it("narrows as tabs are added to a window that does not change", () => {
    // The behaviour a person actually sees: same window, more tabs.
    expect(tabDensity(900, 2)).toBe("full");
    expect(tabDensity(900, 7)).toBe("compact");
    expect(tabDensity(900, 14)).toBe("icons");
  });

  it("assumes room before anything has been measured", () => {
    // Width 0 is "not measured yet", not "no space" — the strip must
    // not open as icons and then flash back to names.
    expect(tabDensity(0, 5)).toBe("full");
    expect(tabDensity(1200, 0)).toBe("full");
  });
});
