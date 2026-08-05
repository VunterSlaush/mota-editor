import { describe, expect, it } from "vitest";
import { formatElapsed } from "./duration";

describe("formatElapsed", () => {
  it("reads as plain seconds under a minute", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(999)).toBe("0s");
    expect(formatElapsed(12_000)).toBe("12s");
    expect(formatElapsed(59_999)).toBe("59s");
  });

  it("switches to minutes with zero-padded seconds", () => {
    expect(formatElapsed(60_000)).toBe("1m 00s");
    expect(formatElapsed(64_000)).toBe("1m 04s");
    expect(formatElapsed(3_599_000)).toBe("59m 59s");
  });

  it("switches to hours for very long turns", () => {
    expect(formatElapsed(3_600_000)).toBe("1h 00m 00s");
    expect(formatElapsed(7_384_000)).toBe("2h 03m 04s");
  });

  it("never reads negative when the clock jumps backwards", () => {
    expect(formatElapsed(-5_000)).toBe("0s");
  });
});
