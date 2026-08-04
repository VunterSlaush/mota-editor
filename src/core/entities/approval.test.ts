import { describe, expect, it } from "vitest";
import { permissionOptionHint } from "./approval";

describe("approval entity", () => {
  it("explains every mode the agent can leave the session in", () => {
    for (const id of ["auto", "acceptEdits", "default", "bypassPermissions", "plan"]) {
      expect(permissionOptionHint(id)).toBeTruthy();
    }
  });

  it("tells auto and accept-edits apart — the whole point", () => {
    expect(permissionOptionHint("auto")).not.toBe(permissionOptionHint("acceptEdits"));
    expect(permissionOptionHint("acceptEdits")).toContain("Commands still ask");
  });

  it("says nothing about ordinary allow/deny, which speak for themselves", () => {
    expect(permissionOptionHint("allow")).toBeUndefined();
    expect(permissionOptionHint("reject")).toBeUndefined();
  });
});
