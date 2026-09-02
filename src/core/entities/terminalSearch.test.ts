import { describe, expect, it } from "vitest";
import { terminalSearchIntent } from "./terminalSearch";

/** A keydown with nothing held, overridden per case. */
const key = (over: Partial<Parameters<typeof terminalSearchIntent>[0]>) => ({
  key: "f",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe("terminalSearchIntent", () => {
  it("opens the search bar on Ctrl+F away from a Mac", () => {
    expect(terminalSearchIntent(key({ ctrlKey: true }), { isMac: false })).toBe("open");
  });

  it("opens it on Cmd+F on a Mac", () => {
    expect(terminalSearchIntent(key({ metaKey: true }), { isMac: true })).toBe("open");
  });

  it("leaves Ctrl+F to the shell on a Mac, where Cmd is the app's modifier", () => {
    expect(terminalSearchIntent(key({ ctrlKey: true }), { isMac: true })).toBeNull();
  });

  it("ignores Cmd+F away from a Mac", () => {
    expect(terminalSearchIntent(key({ metaKey: true }), { isMac: false })).toBeNull();
  });

  it("also takes Ctrl+Shift+F, which other terminals bind to the same thing", () => {
    expect(
      terminalSearchIntent(key({ ctrlKey: true, shiftKey: true }), { isMac: false }),
    ).toBe("open");
  });

  it("lets AltGr through, which arrives as Ctrl+Alt and types real characters", () => {
    expect(
      terminalSearchIntent(key({ ctrlKey: true, altKey: true }), { isMac: false }),
    ).toBeNull();
  });

  it("claims no key but F", () => {
    expect(
      terminalSearchIntent(key({ key: "g", ctrlKey: true }), { isMac: false }),
    ).toBeNull();
  });

  it("reads the key case-insensitively, as Shift and CapsLock both change it", () => {
    expect(terminalSearchIntent(key({ key: "F", ctrlKey: true }), { isMac: false })).toBe(
      "open",
    );
  });

  it("wants a modifier — a bare f is text", () => {
    expect(terminalSearchIntent(key({}), { isMac: false })).toBeNull();
  });
});
