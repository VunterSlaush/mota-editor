import { describe, expect, it } from "vitest";
import {
  approvalMessage,
  assistantMessage,
  type ChatMessage,
  errorMessage,
  infoMessage,
  toolMessage,
  userMessage,
} from "./message";
import { hasPendingRequest, tabStatus } from "./tabStatus";

const tab = (messages: readonly ChatMessage[], busy = false, attention = false) => ({
  messages,
  busy,
  attention,
});

const pending = () =>
  approvalMessage("Run npm test", {
    requestId: "r1",
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  });

const answered = () => {
  const m = pending();
  return { ...m, approval: { ...m.approval!, resolvedOptionId: "allow" } };
};

const cancelled = () => {
  const m = pending();
  return { ...m, approval: { ...m.approval!, cancelled: true } };
};

describe("hasPendingRequest", () => {
  it("is true only while an approval is unanswered", () => {
    expect(hasPendingRequest([pending()])).toBe(true);
    expect(hasPendingRequest([answered()])).toBe(false);
    expect(hasPendingRequest([cancelled()])).toBe(false);
    expect(hasPendingRequest([assistantMessage("hi")])).toBe(false);
    expect(hasPendingRequest([])).toBe(false);
  });
});

describe("tabStatus", () => {
  it("is idle for an untouched tab", () => {
    expect(tabStatus(tab([]))).toBe("idle");
    expect(tabStatus(tab([assistantMessage("done")]))).toBe("idle");
  });

  it("is busy while a turn runs", () => {
    expect(tabStatus(tab([userMessage("go")], true))).toBe("busy");
  });

  it("needsInput outranks busy — a waiting turn is still a running turn", () => {
    expect(tabStatus(tab([userMessage("go"), pending()], true))).toBe("needsInput");
  });

  it("needsInput outranks error and done", () => {
    expect(tabStatus(tab([errorMessage("boom"), pending()], false, true))).toBe(
      "needsInput",
    );
  });

  it("reports an error once the turn has stopped", () => {
    expect(tabStatus(tab([userMessage("go"), errorMessage("boom")]))).toBe("error");
  });

  it("does not report an error while the turn is still going", () => {
    // A recoverable mid-turn error must not latch the tab red.
    expect(tabStatus(tab([errorMessage("retrying"), userMessage("go")], true))).toBe(
      "busy",
    );
  });

  it("looks past trailing tool and info rows to find the error", () => {
    const messages = [
      errorMessage("boom"),
      toolMessage("read", "x"),
      infoMessage("cleanup"),
    ];
    expect(tabStatus(tab(messages))).toBe("error");
  });

  it("a later reply clears the error", () => {
    expect(tabStatus(tab([errorMessage("boom"), assistantMessage("recovered")]))).toBe(
      "idle",
    );
  });

  it("error outranks done", () => {
    expect(tabStatus(tab([errorMessage("boom")], false, true))).toBe("error");
  });

  it("is done when a clean turn finished off-screen", () => {
    expect(tabStatus(tab([assistantMessage("all set")], false, true))).toBe("done");
  });
});
