import { describe, expect, it } from "vitest";
import { terminalClipboardIntent } from "./terminalClipboard";

const press = (
  key: string,
  held: Partial<Record<"ctrl" | "meta" | "shift" | "alt", true>> = {},
) => ({
  key,
  ctrlKey: held.ctrl === true,
  metaKey: held.meta === true,
  shiftKey: held.shift === true,
  altKey: held.alt === true,
});

const pc = { hasSelection: false, isMac: false };
const mac = { hasSelection: false, isMac: true };

describe("terminalClipboardIntent", () => {
  it("copies Ctrl+C only when something is selected", () => {
    expect(
      terminalClipboardIntent(press("c", { ctrl: true }), { ...pc, hasSelection: true }),
    ).toBe("copy");
    // Nothing selected: the key stays the interrupt it has always been.
    expect(terminalClipboardIntent(press("c", { ctrl: true }), pc)).toBeNull();
  });

  it("treats Ctrl+Shift+C as copy whatever is selected", () => {
    expect(terminalClipboardIntent(press("C", { ctrl: true, shift: true }), pc)).toBe(
      "copy",
    );
  });

  it("always pastes on Ctrl+V and Ctrl+Shift+V", () => {
    expect(terminalClipboardIntent(press("v", { ctrl: true }), pc)).toBe("paste");
    expect(terminalClipboardIntent(press("V", { ctrl: true, shift: true }), pc)).toBe(
      "paste",
    );
  });

  it("leaves unmodified and Alt-modified keys to the shell", () => {
    expect(terminalClipboardIntent(press("c"), { ...pc, hasSelection: true })).toBeNull();
    expect(terminalClipboardIntent(press("v"), pc)).toBeNull();
    // AltGr arrives as Ctrl+Alt and types real characters.
    expect(terminalClipboardIntent(press("v", { ctrl: true, alt: true }), pc)).toBeNull();
  });

  it("ignores other letters", () => {
    expect(
      terminalClipboardIntent(press("d", { ctrl: true }), { ...pc, hasSelection: true }),
    ).toBeNull();
    expect(terminalClipboardIntent(press("x", { ctrl: true }), pc)).toBeNull();
  });

  it("uses Cmd on macOS and leaves Ctrl+C interrupting there", () => {
    expect(
      terminalClipboardIntent(press("c", { meta: true }), { ...mac, hasSelection: true }),
    ).toBe("copy");
    expect(terminalClipboardIntent(press("v", { meta: true }), mac)).toBe("paste");
    // Ctrl is the shell's on a Mac, selection or not.
    expect(
      terminalClipboardIntent(press("c", { ctrl: true }), { ...mac, hasSelection: true }),
    ).toBeNull();
    // And Cmd means nothing to a terminal on anything else.
    expect(terminalClipboardIntent(press("v", { meta: true }), pc)).toBeNull();
  });

  it("refuses both modifiers at once", () => {
    expect(
      terminalClipboardIntent(press("v", { ctrl: true, meta: true }), pc),
    ).toBeNull();
    expect(
      terminalClipboardIntent(press("v", { ctrl: true, meta: true }), mac),
    ).toBeNull();
  });
});
