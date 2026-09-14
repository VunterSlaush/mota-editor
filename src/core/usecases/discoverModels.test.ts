import { expect, it } from "vitest";
import type { ProviderProbe, ProviderStatus } from "../ports/providerProbe";
import { Store } from "../state/store";
import { DiscoverModels } from "./discoverModels";

it("publishes discovered models and retries after an unavailable catalog", async () => {
  const store = new Store();
  let ready = false;
  const catalog = {
    defaultModel: "new",
    models: [{ id: "new", name: "New", efforts: ["low"] }],
  };
  const probe: ProviderProbe = {
    async probe(provider) {
      if (!ready) throw new Error("Offline");
      return {
        provider,
        catalog,
        readiness: "started",
        detail: "",
        installHint: "",
        signInCommand: "",
      } as ProviderStatus;
    },
    async signIn() {},
  };
  const discover = new DiscoverModels(store, probe);
  await discover.execute("codex", "/repo");
  expect(store.getState().modelProblems?.codex).toContain("Offline");
  ready = true;
  await discover.recheck("codex", "/repo");
  expect(store.getState().modelCatalogs?.codex).toEqual(catalog);
  expect(store.getState().modelProblems?.codex).toBeUndefined();
});
