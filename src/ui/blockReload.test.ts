import { describe, expect, it } from "vitest";
import { isReloadShortcut } from "./blockReload";

/** A keydown as the webview reports it; only the fields that decide. */
const key = (init: Partial<KeyboardEvent>) =>
  ({ key: "", ctrlKey: false, metaKey: false, ...init }) as KeyboardEvent;

describe("isReloadShortcut", () => {
  it("catches every way a webview is asked to reload", () => {
    expect(isReloadShortcut(key({ key: "F5" }))).toBe(true);
    expect(isReloadShortcut(key({ key: "F5", ctrlKey: true }))).toBe(true);
    expect(isReloadShortcut(key({ key: "r", ctrlKey: true }))).toBe(true);
    expect(isReloadShortcut(key({ key: "r", metaKey: true }))).toBe(true);
    // Ctrl+Shift+R — the shift is in the case of the key itself.
    expect(isReloadShortcut(key({ key: "R", ctrlKey: true }))).toBe(true);
  });

  it("leaves an unmodified key alone", () => {
    // Typing "r" into the composer must not be swallowed.
    expect(isReloadShortcut(key({ key: "r" }))).toBe(false);
    expect(isReloadShortcut(key({ key: "R" }))).toBe(false);
  });

  it("leaves other shortcuts alone", () => {
    expect(isReloadShortcut(key({ key: "s", ctrlKey: true }))).toBe(false);
    expect(isReloadShortcut(key({ key: "F6" }))).toBe(false);
  });
});
