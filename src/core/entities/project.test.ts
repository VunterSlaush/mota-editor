import { describe, expect, it } from "vitest";
import {
  defaultsFromProject,
  duplicatedProject,
  MAX_TAB_LABEL_LENGTH,
  newProject,
  normalizedTabLabel,
  type ProjectDefaults,
  projectNameFromPath,
  tabLabel,
} from "./project";

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

  it("calls a tab by the user's name when it has one, and its folder's when not", () => {
    const project = newProject("t1", "/work/alpha", defaults);
    expect(tabLabel(project)).toBe("alpha");
    expect(tabLabel({ ...project, label: "auth rewrite" })).toBe("auth rewrite");
  });

  it("stores a name trimmed, and nothing at all when there is nothing left", () => {
    expect(normalizedTabLabel("  auth rewrite  ")).toBe("auth rewrite");
    expect(normalizedTabLabel("   ")).toBeUndefined();
    expect(normalizedTabLabel("")).toBeUndefined();
  });

  it("caps a name at a length the strip could never show anyway", () => {
    const long = "x".repeat(MAX_TAB_LABEL_LENGTH + 20);
    expect(normalizedTabLabel(long)).toHaveLength(MAX_TAB_LABEL_LENGTH);
  });

  it("seeds a new project with the colour it was given, and no key without one", () => {
    expect(newProject("t1", "/a", { ...defaults, color: "teal" }).color).toBe("teal");
    // Absent, not undefined: a key that exists reads as a decision made.
    expect("color" in newProject("t1", "/a", defaults)).toBe(false);
  });

  it("passes a tab's colour to what it seeds, but never its name", () => {
    const source = newProject("t1", "/work/alpha", defaults);
    const seeded = defaultsFromProject({ ...source, color: "violet", label: "auth" });
    expect(seeded.color).toBe("violet");
    expect("label" in seeded).toBe(false);
  });
});

describe("duplicating a project", () => {
  const source = {
    ...newProject("t1", "/work/alpha", { ...defaults, color: "teal" }),
    verbose: false,
    mcpOverrides: { s1: true },
    provisioningOverride: [{ path: "node_modules", strategy: "clone" as const }],
    worktreeOf: "/work/main",
  };

  it("points the copy at the same folder, under its own tab id", () => {
    const copy = duplicatedProject(source, "t2");
    expect(copy.id).toBe("t2");
    expect(copy.path).toBe("/work/alpha");
    expect(copy.name).toBe("alpha");
  });

  it("sets the copy up exactly like the tab it came from", () => {
    // The whole point of duplicating: a second conversation in a setup
    // you already chose, not one back on the app defaults.
    const copy = duplicatedProject(source, "t2");
    expect(copy.provider).toBe(source.provider);
    expect(copy.mode).toBe(source.mode);
    expect(copy.permission).toBe(source.permission);
    expect(copy.model).toBe(source.model);
    expect(copy.effort).toBe(source.effort);
    expect(copy.verbose).toBe(false);
    expect(copy.color).toBe("teal");
    expect(copy.mcpOverrides).toEqual({ s1: true });
    expect(copy.provisioningOverride).toEqual(source.provisioningOverride);
  });

  it("stays the worktree its source was, so the icon still tells the truth", () => {
    expect(duplicatedProject(source, "t2").worktreeOf).toBe("/work/main");
  });

  it("never takes the conversation with it", () => {
    // Provider sessions belong to the tab that started them: two tabs
    // resuming one session would both be writing to that conversation.
    const talking = { ...source, providerSessions: { codex: "codex-abc" } };
    expect(duplicatedProject(talking, "t2").providerSessions).toEqual({});
  });

  it("never takes the name with it, so the copy can be told apart", () => {
    const named = { ...source, label: "auth rewrite" };
    expect("label" in duplicatedProject(named, "t2")).toBe(false);
  });

  it("leaves absent overrides absent rather than present and undefined", () => {
    const plain = newProject("t1", "/work/alpha", defaults);
    const copy = duplicatedProject(plain, "t2");
    expect("color" in copy).toBe(false);
    expect("mcpOverrides" in copy).toBe(false);
    expect("provisioningOverride" in copy).toBe(false);
  });
});
