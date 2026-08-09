import { describe, expect, it } from "vitest";
import {
  declineOption,
  isDecline,
  pendingPlanApproval,
  permissionOptionHint,
} from "./approval";
import { approvalMessage, assistantMessage } from "./message";

const PLAN_OPTIONS = [
  { optionId: "acceptEdits", name: "Yes, and auto-accept edits", kind: "allow_always" },
  { optionId: "default", name: "Yes, manually approve", kind: "allow_once" },
  { optionId: "plan", name: "No, keep planning", kind: "reject_once" },
];

const planCard = (requestId: string) =>
  approvalMessage("Ready to code?", {
    requestId,
    options: PLAN_OPTIONS,
    isPlan: true,
  });

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

describe("declining a plan", () => {
  it("finds the keep-planning option by its kind, not its wording", () => {
    expect(declineOption(PLAN_OPTIONS)?.optionId).toBe("plan");
  });

  it("finds nothing when the agent offers no way to say no", () => {
    expect(
      declineOption([{ optionId: "allow", name: "OK", kind: "allow_once" }]),
    ).toBeUndefined();
  });

  it("recognises the chosen option as a decline", () => {
    expect(isDecline(PLAN_OPTIONS, "plan")).toBe(true);
    expect(isDecline(PLAN_OPTIONS, "acceptEdits")).toBe(false);
    expect(isDecline(PLAN_OPTIONS, "nonexistent")).toBe(false);
  });
});

describe("pendingPlanApproval", () => {
  it("finds the plan the agent is waiting on", () => {
    const messages = [assistantMessage("here it is"), planCard("r1")];
    expect(pendingPlanApproval(messages)?.requestId).toBe("r1");
  });

  it("ignores a plan the user already answered", () => {
    const card = planCard("r1");
    const answered = {
      ...card,
      approval: { ...card.approval!, resolvedOptionId: "plan" },
    };
    expect(pendingPlanApproval([answered])).toBeUndefined();
  });

  it("ignores a plan stranded by a cancelled turn", () => {
    const card = planCard("r1");
    const stranded = { ...card, approval: { ...card.approval!, cancelled: true } };
    expect(pendingPlanApproval([stranded])).toBeUndefined();
  });

  it("ignores an ordinary tool approval — only a plan parks the turn", () => {
    const tool = approvalMessage("Run npm test", {
      requestId: "r2",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });
    expect(pendingPlanApproval([tool])).toBeUndefined();
  });

  it("answers with the newest plan when the agent presented two", () => {
    expect(pendingPlanApproval([planCard("r1"), planCard("r2")])?.requestId).toBe("r2");
  });
});
