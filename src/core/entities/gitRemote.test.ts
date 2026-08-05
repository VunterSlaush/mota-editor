import { describe, expect, it } from "vitest";
import { commitUrl } from "./gitRemote";

const HASH = "a1b2c3d";

describe("commitUrl", () => {
  it("builds GitHub links from every remote spelling", () => {
    const expected = `https://github.com/mota/mota-editor/commit/${HASH}`;
    for (const remote of [
      "git@github.com:mota/mota-editor.git",
      "git@github.com:mota/mota-editor",
      "https://github.com/mota/mota-editor.git",
      "https://github.com/mota/mota-editor",
      "ssh://git@github.com/mota/mota-editor.git",
      "  https://github.com/mota/mota-editor.git\n",
    ]) {
      expect(commitUrl(remote, HASH)).toBe(expected);
    }
  });

  it("uses each forge's own commit path", () => {
    expect(commitUrl("git@gitlab.com:mota/app.git", HASH)).toBe(
      `https://gitlab.com/mota/app/-/commit/${HASH}`,
    );
    expect(commitUrl("https://bitbucket.org/mota/app.git", HASH)).toBe(
      `https://bitbucket.org/mota/app/commits/${HASH}`,
    );
  });

  it("keeps nested group paths intact", () => {
    expect(commitUrl("git@gitlab.com:team/sub/app.git", HASH)).toBe(
      `https://gitlab.com/team/sub/app/-/commit/${HASH}`,
    );
  });

  it("recognises self-hosted forges by host name", () => {
    expect(commitUrl("https://github.acme.com/team/app.git", HASH)).toBe(
      `https://github.acme.com/team/app/commit/${HASH}`,
    );
  });

  it("never carries a credential into the URL", () => {
    const url = commitUrl("https://mota:ghp_secret@github.com/mota/app.git", HASH);
    expect(url).toBe(`https://github.com/mota/app/commit/${HASH}`);
    expect(url).not.toContain("ghp_secret");
  });

  it("drops an ssh port", () => {
    expect(commitUrl("ssh://git@github.com:22/mota/app.git", HASH)).toBe(
      `https://github.com/mota/app/commit/${HASH}`,
    );
  });

  it("returns null rather than guessing", () => {
    expect(commitUrl("", HASH)).toBeNull();
    expect(commitUrl("   ", HASH)).toBeNull();
    expect(commitUrl("git@github.com:mota/app.git", "")).toBeNull();
    // A local path, and a forge we have no URL scheme for.
    expect(commitUrl("/srv/git/app.git", HASH)).toBeNull();
    expect(commitUrl("https://dev.azure.com/org/proj/_git/app", HASH)).toBeNull();
  });
});
