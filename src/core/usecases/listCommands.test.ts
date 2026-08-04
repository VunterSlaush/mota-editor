import { describe, expect, it } from "vitest";
import type { CommandInfo } from "../entities/command";
import { newProject } from "../entities/project";
import type { CommandCatalog } from "../ports/commandCatalog";
import { Store } from "../state/store";
import { ListCommands } from "./listCommands";

class FakeCommandCatalog implements CommandCatalog {
  custom: CommandInfo[] = [];
  shouldFail = false;

  async listCustomCommands(): Promise<CommandInfo[]> {
    if (this.shouldFail) throw new Error("scan failed");
    return this.custom;
  }
}

function setup() {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", "claude"),
  });
  const catalog = new FakeCommandCatalog();
  return { store, catalog, useCase: new ListCommands(store, catalog) };
}

describe("ListCommands", () => {
  it("merges built-ins with discovered custom commands, sorted by name", async () => {
    const { catalog, useCase } = setup();
    catalog.custom = [{ name: "/deploy", description: "Ship it", source: "custom" }];

    const commands = await useCase.execute("t1");

    const names = commands.map((c) => c.name);
    expect(names).toContain("/init");
    expect(names).toContain("/deploy");
    expect(names).toEqual([...names].sort());
  });

  it("custom commands never shadow a built-in with the same name", async () => {
    const { catalog, useCase } = setup();
    catalog.custom = [{ name: "/init", description: "impostor", source: "custom" }];

    const commands = await useCase.execute("t1");

    const init = commands.filter((c) => c.name === "/init");
    expect(init).toHaveLength(1);
    expect(init[0].source).toBe("builtin");
  });

  it("falls back to built-ins when discovery fails", async () => {
    const { catalog, useCase } = setup();
    catalog.shouldFail = true;

    const commands = await useCase.execute("t1");

    expect(commands.length).toBeGreaterThan(0);
    expect(commands.every((c) => c.source === "builtin")).toBe(true);
  });

  it("returns nothing for an unknown tab", async () => {
    const { useCase } = setup();
    expect(await useCase.execute("nope")).toEqual([]);
  });
});
