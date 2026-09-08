import { describe, expect, it } from "vitest";
import { leadingCommand } from "./commandConfig";
import {
  type CommandSequence,
  commandsFromSequences,
  findSequence,
  isReservedSequenceName,
  isRunnableSequence,
  MAX_SEQUENCE_STEPS,
  normalizedSequenceName,
  restoredSequences,
  sequenceSteps,
} from "./commandSequence";

const sequence = (
  name: string,
  steps: readonly string[],
  description = "",
): CommandSequence => ({ id: name, name, description, steps });

const SHIP = sequence("ship", ["/review", "write tests", "/commit-push"], "Ship it");

describe("normalizedSequenceName", () => {
  it("adds the slash a user is not required to type", () => {
    expect(normalizedSequenceName("ship")).toBe("/ship");
  });

  it("leaves a name that already has one alone", () => {
    expect(normalizedSequenceName("/ship")).toBe("/ship");
  });

  it("keeps the name to a single invokable token", () => {
    // Only a leading token ever reaches `leadingCommand`, so a name with
    // a space in it would be a command nobody could run.
    expect(normalizedSequenceName("  //ship it  ")).toBe("/ship");
  });

  it("has no name to normalize when nothing was typed", () => {
    expect(normalizedSequenceName("  /  ")).toBe("");
  });
});

describe("isRunnableSequence", () => {
  it("accepts a name with at least one step", () => {
    expect(isRunnableSequence(SHIP)).toBe(true);
  });

  it("refuses a sequence with no name", () => {
    expect(isRunnableSequence(sequence("", ["/review"]))).toBe(false);
  });

  it("refuses a sequence whose steps are all blank", () => {
    expect(isRunnableSequence(sequence("ship", ["", "   "]))).toBe(false);
  });
});

describe("isReservedSequenceName", () => {
  it("refuses a name Mota answers itself", () => {
    expect(isReservedSequenceName("/clear")).toBe(true);
    expect(isReservedSequenceName("/install-extension")).toBe(true);
  });

  it("allows a name only the agent knows", () => {
    expect(isReservedSequenceName("/review")).toBe(false);
  });
});

describe("findSequence", () => {
  it("matches the typed token case-insensitively, like the palette", () => {
    expect(findSequence([SHIP], "/SHIP")?.name).toBe("ship");
  });

  it("finds nothing for a token no sequence claims", () => {
    expect(findSequence([SHIP], "/nope")).toBeNull();
  });

  it("ignores a half-filled row, which is a draft rather than a command", () => {
    expect(findSequence([sequence("ship", [])], "/ship")).toBeNull();
  });

  it("never answers for a name Mota handles itself", () => {
    expect(findSequence([sequence("clear", ["/review"])], "/clear")).toBeNull();
  });
});

describe("commandsFromSequences", () => {
  it("lists a sequence as a palette entry tagged with its source", () => {
    expect(commandsFromSequences([SHIP])).toEqual([
      { name: "/ship", description: "Ship it", source: "sequence" },
    ]);
  });

  it("describes an undescribed sequence by how much it will run", () => {
    const [command] = commandsFromSequences([sequence("ship", ["/review", "ship it"])]);
    expect(command.description).toBe("2 steps");
  });

  it("leaves out a row that is not runnable yet", () => {
    expect(commandsFromSequences([sequence("", ["/review"])])).toEqual([]);
  });

  it("leaves out a name Mota answers itself, which could never run", () => {
    expect(commandsFromSequences([sequence("clear", ["/review"])])).toEqual([]);
  });

  it("offers one entry per name, so a duplicate cannot show up twice", () => {
    const commands = commandsFromSequences([SHIP, sequence("ship", ["/deploy"])]);
    expect(commands.map((c) => c.name)).toEqual(["/ship"]);
  });
});

describe("sequenceSteps", () => {
  it("has nothing to run for a token that is not a sequence", () => {
    expect(sequenceSteps([SHIP], "/nope", "")).toEqual([]);
  });

  it("returns the steps as written when there are no arguments", () => {
    expect(sequenceSteps([SHIP], "/ship", "")).toEqual([
      "/review",
      "write tests",
      "/commit-push",
    ]);
  });

  it("substitutes $ARGUMENTS where the step names it", () => {
    const withPlaceholder = sequence("ship", ["/review $ARGUMENTS", "commit $ARGUMENTS"]);
    expect(sequenceSteps([withPlaceholder], "/ship", "the auth fix")).toEqual([
      "/review the auth fix",
      "commit the auth fix",
    ]);
  });

  it("appends the arguments where a step does not name them", () => {
    expect(sequenceSteps([SHIP], "/ship", "the auth fix")[1]).toBe(
      "write tests\n\nthe auth fix",
    );
  });

  it("drops a blank step rather than sending an empty prompt", () => {
    expect(sequenceSteps([sequence("ship", ["  ", "/review"])], "/ship", "")).toEqual([
      "/review",
    ]);
  });

  it("splices a nested sequence's steps in place", () => {
    const inner = sequence("checks", ["/lint", "/typecheck"]);
    const outer = sequence("ship", ["/review", "/checks", "/commit-push"]);
    expect(sequenceSteps([inner, outer], "/ship", "")).toEqual([
      "/review",
      "/lint",
      "/typecheck",
      "/commit-push",
    ]);
  });

  it("passes a nested step's own arguments down to it", () => {
    const inner = sequence("checks", ["/lint $ARGUMENTS"]);
    const outer = sequence("ship", ["/checks src/core"]);
    expect(sequenceSteps([inner, outer], "/ship", "")).toEqual(["/lint src/core"]);
  });

  it("drops a step that names the sequence it is already inside", () => {
    const selfish = sequence("ship", ["/review", "/ship"]);
    expect(sequenceSteps([selfish], "/ship", "")).toEqual(["/review"]);
  });

  it("drops a step that closes a cycle through another sequence", () => {
    const ping = sequence("ping", ["one", "/pong"]);
    const pong = sequence("pong", ["two", "/ping"]);
    expect(sequenceSteps([ping, pong], "/ping", "")).toEqual(["one", "two"]);
  });

  it("still runs a sequence twice when the two uses are not nested", () => {
    const inner = sequence("checks", ["/lint"]);
    const outer = sequence("ship", ["/checks", "/review", "/checks"]);
    expect(sequenceSteps([inner, outer], "/ship", "")).toEqual([
      "/lint",
      "/review",
      "/lint",
    ]);
  });

  it("stops at the step ceiling however deep the nesting goes", () => {
    const long = sequence(
      "long",
      Array.from({ length: MAX_SEQUENCE_STEPS }, (_, i) => `step ${i}`),
    );
    const twice = sequence("twice", ["/long", "/long"]);
    expect(sequenceSteps([long, twice], "/twice", "")).toHaveLength(MAX_SEQUENCE_STEPS);
  });
});

/**
 * The property the whole design rests on: steps 2..N re-enter SendPrompt
 * through the queue as provenance-free strings, so nothing downstream can
 * tell a sequence's step from a typed prompt. If a step could name a
 * sequence, `execute` would recurse without ever yielding to a turn —
 * unbounded. Flattening here makes that recursion provably depth-1.
 */
describe("a flattened sequence never names another sequence", () => {
  it("holds for any graph of sequences, including cyclic ones", () => {
    let seed = 20260908;
    const random = (bound: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % bound;
    };

    for (let attempt = 0; attempt < 200; attempt++) {
      const size = 1 + random(5);
      const names = Array.from({ length: size }, (_, i) => `s${i}`);
      const sequences = names.map((name) =>
        sequence(
          name,
          Array.from({ length: 1 + random(4) }, () =>
            random(2) === 0 ? `/${names[random(size)]}` : "prose",
          ),
        ),
      );

      for (const start of names) {
        for (const step of sequenceSteps(sequences, `/${start}`, "")) {
          expect(findSequence(sequences, leadingCommand(step) ?? "")).toBeNull();
        }
      }
    }
  });
});

describe("restoredSequences", () => {
  it("brings back a well-formed row", () => {
    const row = { id: "a", name: "ship", description: "", steps: ["go"] };
    expect(restoredSequences([row])).toEqual([row]);
  });

  it("drops a row with no steps, which could never run", () => {
    expect(restoredSequences([{ id: "a", name: "ship", steps: [] }])).toBeUndefined();
  });

  it("drops a row whose steps are not strings", () => {
    expect(
      restoredSequences([{ id: "a", name: "ship", steps: [42, null] }]),
    ).toBeUndefined();
  });

  it("drops a row with no id, which the settings list could not key", () => {
    expect(restoredSequences([{ name: "ship", steps: ["go"] }])).toBeUndefined();
  });

  it("keeps the good rows alongside a broken one", () => {
    const restored = restoredSequences([
      { id: "a", name: "", steps: ["go"] },
      { id: "b", name: "ship", steps: ["go"] },
    ]);
    expect(restored?.map((s) => s.id)).toEqual(["b"]);
  });

  it("has nothing to restore from a file that never had the field", () => {
    expect(restoredSequences(undefined)).toBeUndefined();
  });
});
