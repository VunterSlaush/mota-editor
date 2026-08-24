import { describe, expect, it } from "vitest";
import { noticeParts } from "./gitAction";

describe("noticeParts", () => {
  it("reads the sentence above the blank line as the headline", () => {
    const parts = noticeParts(
      "Pushed main to monalee-inc/mota-editor.\n\nTo github.com:monalee-inc/mota-editor.git\n   3c5f926..b169a7c  main -> main",
    );

    expect(parts.headline).toBe("Pushed main to monalee-inc/mota-editor.");
    expect(parts.detail).toContain("3c5f926..b169a7c");
  });

  it("has no detail for a message that is only a sentence", () => {
    expect(noticeParts("Everything up to date — nothing to push.")).toEqual({
      headline: "Everything up to date — nothing to push.",
      detail: "",
    });
  });

  it("keeps a multi-line message whole rather than cutting it at line one", () => {
    // git output we did not recognise arrives with no headline of its
    // own; showing only its first line would hide the reason.
    const raw = "error: failed to push some refs\n ! [rejected]  main -> main";

    expect(noticeParts(raw)).toEqual({ headline: raw, detail: "" });
  });

  it("trims the padding git leaves around its output", () => {
    const parts = noticeParts("  Pulled.  \n\n  Fast-forward\n 2 files changed  \n\n");

    expect(parts.headline).toBe("Pulled.");
    expect(parts.detail).toBe("Fast-forward\n 2 files changed");
  });

  it("has nothing to say about an empty message", () => {
    expect(noticeParts("")).toEqual({ headline: "", detail: "" });
  });
});
