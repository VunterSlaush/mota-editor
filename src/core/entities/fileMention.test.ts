import { describe, expect, it } from "vitest";
import {
  FILE_MENTION_LIMIT,
  filterFiles,
  mentionToken,
  replaceMention,
} from "./fileMention";

const FILES = [
  "README.md",
  "src/ui/components/Composer.tsx",
  "src/core/state/composerState.ts",
  "src/core/entities/command.ts",
  "docs/ARCHITECTURE.md",
];

describe("mentionToken", () => {
  it("reads the trailing @word as a mention", () => {
    expect(mentionToken("look at @src/ui")).toBe("@src/ui");
  });

  it("reads a bare @ as a mention", () => {
    expect(mentionToken("look at @")).toBe("@");
  });

  it("treats an email address as ordinary text", () => {
    expect(mentionToken("mail me at jesus@monalee.co")).toBeNull();
  });

  it("has no mention once the token is finished with a space", () => {
    expect(mentionToken("@README.md ")).toBeNull();
  });

  it("finds a mention on the last line of a multi-line draft", () => {
    expect(mentionToken("first line\nthen @doc")).toBe("@doc");
  });

  it("has no mention in plain prose", () => {
    expect(mentionToken("just some words")).toBeNull();
  });
});

describe("filterFiles", () => {
  it("offers the first files for a bare @", () => {
    expect(filterFiles(FILES, "@", 3)).toEqual(FILES.slice(0, 3));
  });

  it("ranks a file whose name starts with the query above a deeper match", () => {
    expect(filterFiles(FILES, "@composer", 10)[0]).toBe("src/ui/components/Composer.tsx");
  });

  it("matches any part of the path, not only the file name", () => {
    expect(filterFiles(FILES, "@entities", 10)).toEqual(["src/core/entities/command.ts"]);
  });

  it("matches regardless of case", () => {
    expect(filterFiles(FILES, "@readme", 10)).toEqual(["README.md"]);
  });

  it("never returns more than the limit", () => {
    expect(filterFiles(FILES, "@", 2)).toHaveLength(2);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterFiles(FILES, "@zzz", 10)).toEqual([]);
  });

  it("shows fifty rows at most by default", () => {
    expect(FILE_MENTION_LIMIT).toBe(50);
  });
});

describe("replaceMention", () => {
  it("replaces only the @token, keeping the text before it", () => {
    expect(replaceMention("look at @comp", "@comp", "src/ui/x.tsx")).toBe(
      "look at src/ui/x.tsx ",
    );
  });

  it("leaves a trailing space, which closes the menu", () => {
    expect(mentionToken(replaceMention("@r", "@r", "README.md"))).toBeNull();
  });

  it("inserts a path containing spaces unquoted", () => {
    expect(replaceMention("@my", "@my", "my docs/a.md")).toBe("my docs/a.md ");
  });
});
