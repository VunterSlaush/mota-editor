import { describe, expect, it } from "vitest";
import {
  applyZoomIntent,
  clampZoomLevel,
  MAX_ZOOM_LEVEL,
  MIN_ZOOM_LEVEL,
  zoomFactor,
  zoomIntent,
  zoomPercent,
} from "./zoom";

const ctrl = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  ctrlKey: true,
  metaKey: false,
  ...extra,
});

describe("zoomFactor", () => {
  it("leaves the interface alone at level zero", () => {
    expect(zoomFactor(0)).toBe(1);
    expect(zoomPercent(0)).toBe(100);
  });

  it("steps by the ratio browsers step by", () => {
    expect(zoomPercent(1)).toBe(120);
    expect(zoomPercent(-1)).toBe(83);
  });

  it("never scales past the usable range", () => {
    expect(zoomFactor(99)).toBe(zoomFactor(MAX_ZOOM_LEVEL));
    expect(zoomFactor(-99)).toBe(zoomFactor(MIN_ZOOM_LEVEL));
  });
});

describe("clampZoomLevel", () => {
  it("keeps a level that is already whole and in range", () => {
    expect(clampZoomLevel(3)).toBe(3);
  });

  it("falls back to untouched for a level that is not a number", () => {
    expect(clampZoomLevel(Number.NaN)).toBe(0);
  });

  it("rounds a fractional level from an older file to a whole notch", () => {
    expect(clampZoomLevel(1.4)).toBe(1);
  });
});

describe("zoomIntent", () => {
  it("reads the main row, with or without the shift that makes a plus", () => {
    expect(zoomIntent(ctrl("="))).toBe("in");
    expect(zoomIntent(ctrl("+"))).toBe("in");
    expect(zoomIntent(ctrl("-"))).toBe("out");
    expect(zoomIntent(ctrl("0"))).toBe("reset");
  });

  it("reads the keypad, whatever the layout calls those keys", () => {
    expect(zoomIntent(ctrl("Unidentified", { code: "NumpadAdd" }))).toBe("in");
    expect(zoomIntent(ctrl("Unidentified", { code: "NumpadSubtract" }))).toBe("out");
    expect(zoomIntent(ctrl("Unidentified", { code: "Numpad0" }))).toBe("reset");
  });

  it("takes Cmd for Ctrl, the way the rest of macOS does", () => {
    expect(zoomIntent({ key: "=", ctrlKey: false, metaKey: true })).toBe("in");
  });

  it("ignores the same keys pressed on their own", () => {
    expect(zoomIntent({ key: "-", ctrlKey: false, metaKey: false })).toBeNull();
    expect(zoomIntent(ctrl("a"))).toBeNull();
  });

  it("leaves Ctrl+Alt combinations to whoever else wants them", () => {
    expect(zoomIntent(ctrl("-", { altKey: true }))).toBeNull();
  });
});

describe("applyZoomIntent", () => {
  it("steps one notch at a time", () => {
    expect(applyZoomIntent(0, "in")).toBe(1);
    expect(applyZoomIntent(1, "out")).toBe(0);
  });

  it("goes straight back to untouched on reset", () => {
    expect(applyZoomIntent(-4, "reset")).toBe(0);
  });

  it("stops at the ends rather than running off them", () => {
    expect(applyZoomIntent(MAX_ZOOM_LEVEL, "in")).toBe(MAX_ZOOM_LEVEL);
    expect(applyZoomIntent(MIN_ZOOM_LEVEL, "out")).toBe(MIN_ZOOM_LEVEL);
  });

  it("returns to where it started after a step out and back", () => {
    expect(applyZoomIntent(applyZoomIntent(2, "out"), "in")).toBe(2);
  });
});
