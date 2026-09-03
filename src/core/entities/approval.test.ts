import { describe, expect, it } from "vitest";
import {
  declineOption,
  isDecline,
  pendingPlanApproval,
  permissionOptionHint,
} from "./approval";
import { approvalMessage, assistantMessage } from "./message";

/** Claude's real plan card, as claude-agent-acp 0.73 sends it. */
const PLAN_OPTIONS = [
  {
    optionId: "exit-plan-clear-auto",
    name: "Yes, clear context (42% used) and use auto mode",
    kind: "allow_always",
  },
  { optionId: "exit-plan-auto", name: "Yes, and use auto mode", kind: "allow_always" },
  {
    optionId: "exit-plan-default",
    name: "Yes, manually approve edits",
    kind: "allow_once",
  },
  { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
];

const planCard = (requestId: string) =>
  approvalMessage("Ready to code?", {
    requestId,
    options: PLAN_OPTIONS,
    isPlan: true,
  });

describe("approval entity", () => {
  it("explains every mode Claude's plan card can leave the session in", () => {
    for (const id of [
      "exit-plan-auto",
      "exit-plan-accept-edits",
      "exit-plan-default",
      "exit-plan-bypass",
      "exit-plan-clear-auto",
      "exit-plan-clear-accept-edits",
      "exit-plan-clear-bypass",
    ]) {
      expect(permissionOptionHint(id)).toBeTruthy();
    }
  });

  it("still explains the ids Claude used before it renamed them", () => {
    for (const id of ["auto", "acceptEdits", "default", "bypassPermissions", "plan"]) {
      expect(permissionOptionHint(id)).toBeTruthy();
    }
  });

  it("explains Codex's plan card, which shares no id with Claude's", () => {
    expect(permissionOptionHint("implement_plan")).toBeTruthy();
    expect(permissionOptionHint("revise_plan")).toBeTruthy();
  });

  it("tells auto and accept-edits apart — the whole point", () => {
    expect(permissionOptionHint("exit-plan-auto")).not.toBe(
      permissionOptionHint("exit-plan-accept-edits"),
    );
    expect(permissionOptionHint("exit-plan-accept-edits")).toContain(
      "Commands still ask",
    );
  });

  it("warns that clearing the context is what costs the conversation", () => {
    expect(permissionOptionHint("exit-plan-clear-auto")).toContain(
      "Drops this conversation",
    );
    expect(permissionOptionHint("exit-plan-auto")).not.toContain(
      "Drops this conversation",
    );
  });

  it("says nothing about ordinary allow/deny, which speak for themselves", () => {
    expect(permissionOptionHint("allow")).toBeUndefined();
    expect(permissionOptionHint("allow-once")).toBeUndefined();
    // Claude spells its keep-planning option `reject` too, and "No, keep
    // planning" needs no help — so the shared id must stay silent.
    expect(permissionOptionHint("reject")).toBeUndefined();
  });
});

describe("declining a plan", () => {
  it("finds the keep-planning option by its kind, not its wording", () => {
    expect(declineOption(PLAN_OPTIONS)?.optionId).toBe("reject");
  });

  it("finds nothing when the agent offers no way to say no", () => {
    expect(
      declineOption([{ optionId: "allow", name: "OK", kind: "allow_once" }]),
    ).toBeUndefined();
  });

  it("recognises the chosen option as a decline", () => {
    expect(isDecline(PLAN_OPTIONS, "reject")).toBe(true);
    expect(isDecline(PLAN_OPTIONS, "exit-plan-auto")).toBe(false);
    expect(isDecline(PLAN_OPTIONS, "nonexistent")).toBe(false);
  });

  it("recognises Codex's revise option, which rejects under its own name", () => {
    const codexPlan = [
      {
        optionId: "implement_plan",
        name: "Yes, implement this plan",
        kind: "allow_once",
      },
      {
        optionId: "revise_plan",
        name: "No, and tell Codex what to do differently",
        kind: "reject_once",
      },
    ];
    expect(declineOption(codexPlan)?.optionId).toBe("revise_plan");
    expect(isDecline(codexPlan, "implement_plan")).toBe(false);
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
      approval: { ...card.approval!, resolvedOptionId: "reject" },
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
