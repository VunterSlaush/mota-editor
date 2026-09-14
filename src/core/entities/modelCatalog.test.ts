import { describe, expect, it } from "vitest";
import {
  commandReasoningChoices,
  modelChoices,
  reasoningChoices,
  supportedEffort,
} from "./modelCatalog";

const catalog = {
  defaultModel: "new-model",
  models: [
    { id: "new-model", name: "New model", efforts: ["low", "ultra"] },
    { id: "small-model", name: "Small model", efforts: ["low", "high"] },
  ],
};

describe("live model choices", () => {
  it("offers all advertised efforts when a command inherits its chat model", () => {
    expect(
      commandReasoningChoices("codex", { ...catalog, defaultModel: "small-model" }, ""),
    ).toEqual(["low", "ultra", "high"]);
    expect(commandReasoningChoices("codex", catalog, "small-model")).toEqual([
      "low",
      "high",
    ]);
  });
  it("uses the advertised models instead of the compiled suggestions", () => {
    expect(modelChoices("codex", catalog, "")).toEqual(["new-model", "small-model"]);
  });
  it("preserves a saved model absent from the catalog", () => {
    expect(modelChoices("codex", catalog, "saved-model")).toEqual([
      "saved-model",
      "new-model",
      "small-model",
    ]);
  });
  it("does not advertise unverified Codex models before discovery", () => {
    expect(modelChoices("codex", undefined, "")).toEqual([]);
  });
  it("uses the default model's reasoning levels for an unset model", () => {
    expect(reasoningChoices("codex", catalog, "")).toEqual(["low", "ultra"]);
  });
  it("drops an effort unsupported by the new model", () => {
    expect(supportedEffort(catalog, "small-model", "ultra")).toBe("");
    expect(supportedEffort(catalog, "small-model", "high")).toBe("high");
  });
});
