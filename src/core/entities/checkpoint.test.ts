import { describe, expect, it } from "vitest";
import type { CheckpointChange } from "../ports/checkpointPort";
import {
  describeRestore,
  describeStat,
  isUnchanged,
  rewindNotice,
  rewindPoints,
} from "./checkpoint";
import { assistantMessage, infoMessage, userMessage } from "./message";

const turn = (sentAt: number, checkpoint?: string) => ({
  sentAt,
  mode: "build",
  permission: "ask",
  ...(checkpoint ? { checkpoint } : {}),
});

describe("rewindPoints", () => {
  it("offers the checkpointed prompts newest first", () => {
    const points = rewindPoints([
      userMessage("first", [], turn(1, "c1")),
      assistantMessage("done"),
      userMessage("second", [], turn(2, "c2")),
      assistantMessage("done"),
    ]);
    expect(points.map((p) => p.prompt)).toEqual(["second", "first"]);
    expect(points[0].checkpoint).toBe("c2");
  });

  it("skips a turn that never got a checkpoint", () => {
    // The project was not a repository yet, or the snapshot ran out of
    // time. Offering the row would promise a restore that cannot happen.
    const points = rewindPoints([
      userMessage("uncheckpointed", [], turn(1)),
      userMessage("checkpointed", [], turn(2, "c2")),
    ]);
    expect(points.map((p) => p.prompt)).toEqual(["checkpointed"]);
  });

  it("ignores everything that is not a user prompt", () => {
    expect(rewindPoints([assistantMessage("hello"), infoMessage("new chat")])).toEqual(
      [],
    );
  });
});

describe("describeStat", () => {
  it("reads as one line of counts", () => {
    expect(describeStat({ files: 7, insertions: 12, deletions: 4 })).toBe(
      "7 files · +12 -4",
    );
  });

  it("drops a count that is zero rather than printing +0", () => {
    expect(describeStat({ files: 1, insertions: 3, deletions: 0 })).toBe("1 file · +3");
    expect(describeStat({ files: 2, insertions: 0, deletions: 9 })).toBe("2 files · -9");
  });

  it("says nothing about counts when there are none", () => {
    expect(describeStat({ files: 0, insertions: 0, deletions: 0 })).toBe("0 files");
  });
});

describe("isUnchanged", () => {
  it("is the read-only turn's answer", () => {
    expect(isUnchanged({ files: 0, insertions: 0, deletions: 0 })).toBe(true);
    expect(isUnchanged({ files: 1, insertions: 0, deletions: 0 })).toBe(false);
  });
});

describe("describeRestore", () => {
  const change = (path: string, fate: "restore" | "delete"): CheckpointChange => ({
    path,
    fate,
    label: fate === "delete" ? "added" : "modified",
  });

  it("names the deletions separately — that is the part to agree to", () => {
    expect(
      describeRestore([
        change("a.ts", "restore"),
        change("b.ts", "restore"),
        change("new.ts", "delete"),
      ]),
    ).toBe("2 files restored, 1 created since then is deleted");
  });

  it("says only what applies", () => {
    expect(describeRestore([change("a.ts", "restore")])).toBe("1 file restored");
    expect(describeRestore([change("new.ts", "delete")])).toBe(
      "1 created since then is deleted",
    );
  });
});

describe("rewindNotice", () => {
  it("warns that the agent still believes it made the edits", () => {
    const notice = rewindNotice({ files: 3, insertions: 10, deletions: 2 });
    expect(notice).toContain("conversation is unchanged");
    expect(notice).toContain("3 files · +10 -2");
  });

  it("says so plainly when there was nothing to undo", () => {
    expect(rewindNotice({ files: 0, insertions: 0, deletions: 0 })).toContain(
      "Nothing to rewind",
    );
  });
});
