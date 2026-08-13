import { describe, expect, it } from "vitest";
import { tooltipPlacement } from "./tooltipPlacement";

const VIEWPORT = { width: 1000, height: 800 };
const TIP = { width: 120, height: 30 };

/** A host rect the way the DOM hands one over. */
function host(left: number, top: number, width = 40, height = 20) {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

describe("tooltipPlacement", () => {
  it("sits under the host, centred on it", () => {
    expect(tooltipPlacement(host(500, 100), TIP, VIEWPORT)).toEqual({
      left: 500 + 20 - 60,
      top: 126,
    });
  });

  it("flips above when there is no room below", () => {
    // The composer's controls live at the bottom of the window — the
    // case that made this function necessary.
    const near = host(500, 770);
    expect(tooltipPlacement(near, TIP, VIEWPORT).top).toBe(770 - 30 - 6);
  });

  it("keeps a left-edge host's tooltip on screen", () => {
    expect(tooltipPlacement(host(0, 100), TIP, VIEWPORT).left).toBe(8);
  });

  it("keeps a right-edge host's tooltip on screen", () => {
    expect(tooltipPlacement(host(980, 100), TIP, VIEWPORT).left).toBe(1000 - 120 - 8);
  });

  it("gives up gracefully when the tooltip is wider than the window", () => {
    const wide = { width: 2000, height: 30 };
    expect(tooltipPlacement(host(500, 100), wide, VIEWPORT).left).toBe(8);
  });

  it("never leaves the top of the window when it flips", () => {
    // A tall tooltip on a host at the very top: below would overflow,
    // above would go off-screen. Staying visible wins.
    const tall = { width: 120, height: 790 };
    expect(tooltipPlacement(host(500, 4), tall, VIEWPORT).top).toBe(8);
  });
});
