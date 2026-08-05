/**
 * Entities layer — turning a git remote into a web address.
 *
 * Remotes come in three shapes (`git@host:owner/repo.git`,
 * `ssh://git@host/owner/repo.git`, `https://host/owner/repo.git`) and
 * each forge spells its commit path differently. Anything unrecognised
 * yields null, and the UI simply doesn't offer a link — a wrong URL is
 * worse than none.
 */

interface Forge {
  /** Matched against the host, so `github.company.com` counts too. */
  readonly host: string;
  /** The path segment between the repo and the hash. */
  readonly commitPath: string;
}

const FORGES: readonly Forge[] = [
  { host: "github", commitPath: "commit" },
  { host: "gitlab", commitPath: "-/commit" },
  { host: "bitbucket", commitPath: "commits" },
];

/** The forge page for one commit, or null when we can't be sure. */
export function commitUrl(remote: string, hash: string): string | null {
  const parsed = parseRemote(remote);
  if (!parsed || hash.trim() === "") return null;

  const forge = FORGES.find((f) => parsed.host.toLowerCase().includes(f.host));
  if (!forge) return null;

  return `https://${parsed.host}/${parsed.repoPath}/${forge.commitPath}/${hash.trim()}`;
}

interface ParsedRemote {
  readonly host: string;
  /** `owner/repo`, without the `.git` suffix. */
  readonly repoPath: string;
}

function parseRemote(remote: string): ParsedRemote | null {
  const trimmed = remote.trim();
  if (trimmed === "") return null;

  // scp-style: git@host:owner/repo.git — no scheme, a colon, no port.
  const scp = /^[^/@]+@([^:/]+):(.+)$/.exec(trimmed);
  if (scp && !trimmed.includes("://")) {
    return build(scp[1], scp[2]);
  }

  // Everything else is a URL. Only http(s) can be opened in a browser,
  // but ssh:// and git:// still identify the same web repo.
  const url = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)\/(.+)$/i.exec(trimmed);
  if (!url) return null;
  // Drop any `user:token@` — a credential must never travel into a
  // browser address bar (or the shell history of whatever opens it).
  const host = url[1].replace(/^[^@]*@/, "");
  return build(host, url[2]);
}

function build(host: string, path: string): ParsedRemote | null {
  const hostname = host.replace(/:\d+$/, ""); // ssh://host:22/...
  const repoPath = path.replace(/\.git\/?$/, "").replace(/^\/+|\/+$/g, "");
  if (hostname === "" || repoPath === "") return null;
  return { host: hostname, repoPath };
}
