import { describe, expect, it } from "vitest";
import { MAX_TAB_SHORTCUT, type TabShortcutKey, tabShortcutIndex } from "./tabShortcut";

/** A Ctrl+<digit> press, as the browser would report it. */
function press(digit: string, over: Partial<TabShortcutKey> = {}): TabShortcutKey {
  return {
    key: digit,
    code: `Digit${digit}`,
    ctrlKey: true,
    metaKey: false,
    ...over,
  };
}

describe("tabShortcutIndex", () => {
  it("counts from zero, so Ctrl+1 is the leftmost tab", () => {
    expect(tabShortcutIndex(press("1"))).toBe(0);
    expect(tabShortcutIndex(press("8"))).toBe(MAX_TAB_SHORTCUT - 1);
  });

  it("takes Cmd as readily as Ctrl", () => {
    expect(tabShortcutIndex(press("2", { ctrlKey: false, metaKey: true }))).toBe(1);
  });

  it("ignores a digit pressed with no modifier at all", () => {
    // Typing "3" into the composer must not move the user off the tab.
    expect(tabShortcutIndex(press("3", { ctrlKey: false }))).toBeNull();
  });

  it("leaves Ctrl+0 to the zoom reset", () => {
    expect(tabShortcutIndex(press("0"))).toBeNull();
  });

  it("stops at the end of the number row rather than running on", () => {
    expect(tabShortcutIndex(press("9"))).toBeNull();
  });

  it("reads the physical key, so a layout that types punctuation still works", () => {
    // AZERTY's unshifted top row is &é"' — the code is what says "1".
    expect(tabShortcutIndex({ ...press("1"), key: "&" })).toBe(0);
  });

  it("takes the numeric keypad too", () => {
    expect(tabShortcutIndex({ ...press("4"), code: "Numpad4" })).toBe(3);
  });

  it("falls back to the key when the event carries no code", () => {
    expect(tabShortcutIndex({ ...press("5"), code: undefined })).toBe(4);
  });

  it("declines Alt, which is how AltGr arrives", () => {
    // AltGr is Ctrl+Alt on Windows, and types digits on several layouts.
    expect(tabShortcutIndex(press("1", { altKey: true }))).toBeNull();
  });

  it("declines Shift, whose code looks identical", () => {
    // Ctrl+Shift+1 is a different gesture; only `key` tells them apart,
    // and `key` is the half this deliberately does not trust.
    expect(tabShortcutIndex(press("1", { key: "!", shiftKey: true }))).toBeNull();
  });

  it("ignores a letter that happens to arrive with Ctrl held", () => {
    expect(tabShortcutIndex({ ...press("1"), key: "a", code: "KeyA" })).toBeNull();
  });
});
