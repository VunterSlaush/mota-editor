import { describe, expect, it } from "vitest";
import type { CommandConfig } from "./commandConfig";
import { commandConfigKey } from "./commandConfig";
import { PROVIDERS, type ProviderId } from "./provider";
import {
  BUILTIN_SUBAGENTS,
  dedupeSubagents,
  delegatedSubagent,
  isAddressableSubagent,
  isNeverDelegated,
  subagentExists,
} from "./subagent";

/**
 * Claude's own mention expander, copied from the `claude` binary
 * (2.1.139). It is the contract: a name this does not match cannot be
 * addressed, and the vendor drops the mention silently rather than
 * failing, so the check has to happen on our side.
 */
const VENDOR_MENTION = /(^|[\s。、？！])@"([\w:.@-]+) \(agent\)"/;

const configs = (entries: Record<string, CommandConfig>) => entries;

describe("BUILTIN_SUBAGENTS", () => {
  it("gives the providers that name their agents something to hand off to", () => {
    for (const id of ["claude", "codex", "gemini", "opencode"] as const) {
      expect(BUILTIN_SUBAGENTS[id].length).toBeGreaterThan(0);
    }
  });

  // Not an oversight, and not a gap to fill in later: Cline spawns
  // sub-agents but exposes no name for one, so there is nothing a
  // mention could resolve. Empty is the honest answer, and it makes
  // every Cline command run in the chat.
  it("leaves a provider that names no agent empty rather than inventing one", () => {
    expect(BUILTIN_SUBAGENTS.cline).toEqual([]);
  });

  it("names every built-in so the vendor's mention grammar accepts it", () => {
    for (const provider of PROVIDERS) {
      for (const agent of BUILTIN_SUBAGENTS[provider.id]) {
        expect(isAddressableSubagent(agent.name)).toBe(true);
        expect(`@"${agent.name} (agent)"`).toMatch(VENDOR_MENTION);
      }
    }
  });
});

describe("isAddressableSubagent", () => {
  it("accepts the shapes real agent names take", () => {
    for (const name of ["general-purpose", "codebase_investigator", "mota.commit", "a"]) {
      expect(isAddressableSubagent(name)).toBe(true);
    }
  });

  it("rejects anything the mention grammar would break on", () => {
    // A slash is the one that matters: an agent named after a command
    // would carry the command's leading slash if nobody stripped it.
    for (const name of ["/commit-push", "two words", "", 'quote"d']) {
      expect(isAddressableSubagent(name)).toBe(false);
      expect(`@"${name} (agent)"`).not.toMatch(VENDOR_MENTION);
    }
  });
});

describe("isNeverDelegated", () => {
  it("keeps Mota's own commands in the chat", () => {
    expect(isNeverDelegated("claude", "/clear")).toBe(true);
    expect(isNeverDelegated("claude", "/create-extension")).toBe(true);
  });

  it("keeps compaction in the session that is actually full", () => {
    expect(isNeverDelegated("claude", "/compact")).toBe(true);
    expect(isNeverDelegated("codex", "/compact")).toBe(true);
    expect(isNeverDelegated("gemini", "/compress")).toBe(true);
    // Gemini compacts with /compress, so /compact is an ordinary command there.
    expect(isNeverDelegated("gemini", "/compact")).toBe(false);
  });

  it("leaves ordinary commands alone", () => {
    expect(isNeverDelegated("claude", "/commit-push")).toBe(false);
  });
});

describe("delegatedSubagent", () => {
  const key = commandConfigKey("claude", "/commit-push");

  it("returns the configured agent for an eligible command", () => {
    const found = delegatedSubagent(
      configs({ [key]: { agent: "mota-commit-push" } }),
      "claude",
      "/commit-push",
    );
    expect(found).toBe("mota-commit-push");
  });

  it("returns null when the command has no agent configured", () => {
    expect(delegatedSubagent(configs({}), "claude", "/commit-push")).toBeNull();
    expect(
      delegatedSubagent(
        configs({ [key]: { model: "sonnet" } }),
        "claude",
        "/commit-push",
      ),
    ).toBeNull();
  });

  it("returns null for ordinary prose", () => {
    expect(
      delegatedSubagent(configs({ [key]: { agent: "x" } }), "claude", null),
    ).toBeNull();
  });

  it("does not read another provider's setting", () => {
    expect(
      delegatedSubagent(
        configs({ [key]: { agent: "mota-commit-push" } }),
        "codex",
        "/commit-push",
      ),
    ).toBeNull();
  });

  it("never delegates a command that must stay in the chat", () => {
    const clear = commandConfigKey("claude", "/clear");
    expect(
      delegatedSubagent(
        configs({ [clear]: { agent: "general-purpose" } }),
        "claude",
        "/clear",
      ),
    ).toBeNull();
  });

  it("refuses a name no provider could address rather than sending a broken mention", () => {
    expect(
      delegatedSubagent(
        configs({ [key]: { agent: "/commit-push" } }),
        "claude",
        "/commit-push",
      ),
    ).toBeNull();
  });
});

describe("subagentExists", () => {
  it("answers from the merged list", () => {
    const agents = BUILTIN_SUBAGENTS.claude;
    expect(subagentExists(agents, "Explore")).toBe(true);
    expect(subagentExists(agents, "mota-commit-push")).toBe(false);
  });
});

describe("dedupeSubagents", () => {
  it("keeps one entry per name, first occurrence winning", () => {
    const deduped = dedupeSubagents([
      { name: "reviewer", description: "project", source: "project" },
      { name: "reviewer", description: "user", source: "user" },
      { name: "other", description: "user", source: "user" },
    ]);
    expect(deduped.map((a) => a.description)).toEqual(["project", "user"]);
  });
});

describe("every provider is covered", () => {
  it("has built-ins keyed by every known provider id", () => {
    const ids: ProviderId[] = PROVIDERS.map((p) => p.id);
    expect(Object.keys(BUILTIN_SUBAGENTS).sort()).toEqual([...ids].sort());
  });
});
