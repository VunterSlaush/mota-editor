import { describe, expect, it } from "vitest";
import { newProject } from "../../core/entities/project";
import { defaultSettings, projectDefaults } from "../../core/state/appState";
import { tabStripLabels } from "./tabStripLabels";

const DEFAULTS = projectDefaults(defaultSettings);

const project = (path: string, label?: string) => ({
  ...newProject(path, path, DEFAULTS),
  ...(label ? { label } : {}),
});

describe("tabStripLabels", () => {
  it("leaves tabs that already read differently alone", () => {
    const labels = tabStripLabels([project("/work/alpha"), project("/work/beta")]);
    expect(labels).toEqual(["alpha", "beta"]);
  });

  it("numbers the second tab on the same folder, keeping the first plain", () => {
    const labels = tabStripLabels([project("/work/alpha"), project("/work/alpha")]);
    expect(labels).toEqual(["alpha", "alpha (2)"]);
  });

  it("keeps counting past the second copy", () => {
    const three = [project("/a/api"), project("/a/api"), project("/a/api")];
    expect(tabStripLabels(three)).toEqual(["api", "api (2)", "api (3)"]);
  });

  it("numbers two different folders that happen to share a name", () => {
    // Two worktrees of one repo, or two projects both called src: the
    // strip has always been able to show these, and never said which.
    const labels = tabStripLabels([project("/one/src"), project("/two/src")]);
    expect(labels).toEqual(["src", "src (2)"]);
  });

  it("counts the name each tab shows, so naming a copy clears its number", () => {
    const labels = tabStripLabels([
      project("/work/alpha"),
      project("/work/alpha", "auth rewrite"),
    ]);
    expect(labels).toEqual(["alpha", "auth rewrite"]);
  });

  it("numbers tabs the user gave the same name to as well", () => {
    const labels = tabStripLabels([
      project("/work/alpha", "api"),
      project("/work/beta", "api"),
    ]);
    expect(labels).toEqual(["api", "api (2)"]);
  });

  it("counts each name on its own", () => {
    const labels = tabStripLabels([
      project("/one/api"),
      project("/one/web"),
      project("/two/api"),
      project("/two/web"),
    ]);
    expect(labels).toEqual(["api", "web", "api (2)", "web (2)"]);
  });
});
