import { EFFORT_OPTIONS, MODEL_SUGGESTIONS, type ProviderId } from "./provider";

/** Models and reasoning levels advertised by the connected provider. */
export interface ModelCatalog {
  readonly defaultModel: string;
  readonly models: readonly {
    readonly id: string;
    readonly name: string;
    readonly efforts: readonly string[];
  }[];
}

export function modelChoices(
  provider: ProviderId,
  catalog: ModelCatalog | undefined,
  saved: string,
): readonly string[] {
  const choices =
    catalog?.models.map((model) => model.id) ??
    (provider === "codex" ? [] : MODEL_SUGGESTIONS[provider]);
  return saved && !choices.includes(saved) ? [saved, ...choices] : choices;
}

export function reasoningChoices(
  provider: ProviderId,
  catalog: ModelCatalog | undefined,
  model: string,
): readonly string[] {
  if (!catalog) return provider === "codex" ? [] : EFFORT_OPTIONS[provider];
  return (
    catalog.models.find((entry) => entry.id === (model || catalog.defaultModel))
      ?.efforts ?? []
  );
}

/** An inherited command model can be any chat model, not just the provider default. */
export function commandReasoningChoices(
  provider: ProviderId,
  catalog: ModelCatalog | undefined,
  model: string,
): readonly string[] {
  if (model || !catalog) return reasoningChoices(provider, catalog, model);
  return [...new Set(catalog.models.flatMap((entry) => entry.efforts))];
}

/** An unsupported effort must not follow a model switch into the next request. */
export function supportedEffort(
  catalog: ModelCatalog | undefined,
  model: string,
  effort: string,
): string {
  const selected = catalog?.models.find(
    (entry) => entry.id === (model || catalog.defaultModel),
  );
  return selected && !selected.efforts.includes(effort) ? "" : effort;
}
