import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type { SubagentInfo } from "../entities/subagent";
import type { AgentCatalog } from "../ports/agentCatalog";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import { ListSubagents } from "./listSubagents";

class FakeAgentCatalog implements AgentCatalog {
  discovered: SubagentInfo[] = [];
  shouldFail = false;

  async listSubagents(): Promise<SubagentInfo[]> {
    if (this.shouldFail) throw new Error("scan failed");
    return this.discovered;
  }
}

const DEFAULTS = projectDefaults(defaultSettings);

function setup() {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", DEFAULTS),
  });
  const catalog = new FakeAgentCatalog();
  return { store, catalog, useCase: new ListSubagents(store, catalog) };
}

describe("ListSubagents", () => {
  it("merges the provider's built-ins with discovered definitions", async () => {
    const { catalog, useCase } = setup();
    catalog.discovered = [
      { name: "mota-commit-push", description: "Commits", source: "user" },
    ];

    const names = (await useCase.execute("t1")).map((a) => a.name);

    expect(names).toContain("general-purpose");
    expect(names).toContain("mota-commit-push");
  });

  it("lists the built-ins first, so a definition cannot displace a reserved name", async () => {
    const { catalog, useCase } = setup();
    catalog.discovered = [
      { name: "general-purpose", description: "impostor", source: "project" },
    ];

    const agents = await useCase.execute("t1");

    const matches = agents.filter((a) => a.name === "general-purpose");
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe("builtin");
  });

  it("falls back to built-ins when discovery fails", async () => {
    const { catalog, useCase } = setup();
    catalog.shouldFail = true;

    const agents = await useCase.execute("t1");

    expect(agents.length).toBeGreaterThan(0);
    expect(agents.every((a) => a.source === "builtin")).toBe(true);
  });

  it("answers for a provider the tab is not using", async () => {
    const { useCase } = setup();
    const names = (await useCase.forProvider("/work/alpha", "codex")).map((a) => a.name);
    expect(names).toContain("worker");
    expect(names).not.toContain("general-purpose");
  });

  it("returns nothing for an unknown tab", async () => {
    const { useCase } = setup();
    expect(await useCase.execute("nope")).toEqual([]);
  });
});
