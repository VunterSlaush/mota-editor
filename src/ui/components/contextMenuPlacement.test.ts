import { describe, expect, it } from "vitest";
import { contextMenuPlacement } from "./contextMenuPlacement";

const VIEWPORT = { width: 1000, height: 800 };
const MENU = { width: 200, height: 120 };

describe("contextMenuPlacement", () => {
  it("puts the menu's top-left corner at the cursor", () => {
    expect(contextMenuPlacement({ x: 300, y: 400 }, MENU, VIEWPORT)).toEqual({
      left: 300,
      top: 400,
    });
  });

  it("flips to the cursor's left when the right edge is in the way", () => {
    // 900 + 200 would overflow, so the menu hangs off the other side and
    // the cursor stays on its edge rather than under its middle.
    expect(contextMenuPlacement({ x: 900, y: 100 }, MENU, VIEWPORT).left).toBe(700);
  });

  it("flips above the cursor when the bottom edge is in the way", () => {
    expect(contextMenuPlacement({ x: 100, y: 750 }, MENU, VIEWPORT).top).toBe(630);
  });

  it("stays inside the window when flipping would leave it too", () => {
    // A menu wider than the space on either side lands at the margin
    // rather than off-screen; the click is still on the row it came from.
    const { left, top } = contextMenuPlacement({ x: 10, y: 10 }, MENU, {
      width: 150,
      height: 100,
    });

    expect(left).toBe(8);
    expect(top).toBe(8);
  });
});
