import { describe, expect, it } from "vitest";
import { newProject, type ProjectDefaults, projectNameFromPath } from "./project";

const defaults: ProjectDefaults = {
  provider: "codex",
  mode: "plan",
  permission: "bypass",
  model: "gpt-5.5",
  effort: "high",
};

describe("project entity", () => {
  it("names a project after its folder, whichever slash the OS uses", () => {
    expect(projectNameFromPath("C:\\work\\alpha")).toBe("alpha");
    expect(projectNameFromPath("/home/u/beta/")).toBe("beta");
  });

  it("starts a new project from the app defaults, not from constants", () => {
    const project = newProject("t1", "/work/alpha", defaults);
    expect(project.provider).toBe("codex");
    expect(project.mode).toBe("plan");
    expect(project.permission).toBe("bypass");
    expect(project.model).toBe("gpt-5.5");
    expect(project.effort).toBe("high");
  });

  it("leaves model and effort unset when the defaults name none", () => {
    const project = newProject("t1", "/work/alpha", {
      provider: "gemini",
      mode: "agent",
      permission: "manual",
    });
    expect(project.model).toBeUndefined();
    expect(project.effort).toBeUndefined();
  });
});
