/**
 * Entities layer — the built-in `/install-extension` command: a prompt
 * template that turns "install the linear one" (or nothing at all) into a
 * brief for whatever agent the tab runs.
 *
 * Installing IS copying a folder into `~/.mota/extensions/`, so the agent
 * already has every tool it needs and the app needs no installer of its
 * own. Like [`createExtensionGuide`](./createExtensionGuide.ts) this ships
 * INSIDE the app, so every install can reach the store — and like it, the
 * command never reaches the agent as a slash command: SendPrompt expands
 * it client-side.
 *
 * What the brief refuses to do is as load-bearing as what it does. The
 * agent shows the permissions and stops for a yes; it never enables
 * anything, because approval is a native dialog only the user can answer.
 */
import { STORE_REGISTRY_URL, STORE_REPO_URL } from "./extensionStore";

export const INSTALL_EXTENSION_COMMAND = "/install-extension";

export const INSTALL_EXTENSION_DESCRIPTION =
  "Install an extension from the store — or list what there is";

const INSTALL_EXTENSION_TEMPLATE = `You are installing a Mota Editor extension for the user (Mota is the app this chat runs in).

What they asked for: __USER_REQUEST__

An extension is a folder in \`~/.mota/extensions/<id>/\` (Windows: \`%USERPROFILE%\\.mota\\extensions\\<id>\\\`) holding a \`mota-extension.json\` manifest and, sometimes, a script. Installing one IS copying that folder there — there is no package manager and nothing to build. If they say they want it for one project only, the folder goes in that project's \`.mota/extensions/<id>/\` instead.

The store is ${STORE_REPO_URL} and its index is
${STORE_REGISTRY_URL}

## If they named nothing — show what there is, install nothing

Read the index (fetch that URL, or \`curl -fsSL\` it) and show every entry as a compact table: the id, what it does, what it adds (commands as \`/name\`, panels), the permissions it asks for, and the entry's "setup" note where it has one. Then say they can run \`/install-extension <id>\` with any id from the list, or \`/install-extension <https clone URL>\` for an extension that is not in the store. Stop there — listing is not installing.

If the index cannot be reached, say so plainly and give them the store URL to browse by hand. Do not invent entries.

## If they named an id from the store

1. Read the index and find the entry. No match: say so, list the ids that do exist, and mention that \`/create-extension\` scaffolds a new one if nobody has built what they want.
2. Get the folder into a temporary directory:
   - \`"source": {"kind": "path"}\` — \`git clone --depth 1 ${STORE_REPO_URL}.git\`; the folder is \`<temp>/extensions/<id>\`.
   - \`"source": {"kind": "git"}\` — \`git clone --depth 1 <source.url>\` (add \`--branch <source.ref>\` when the entry has one); the clone root is the folder.
3. Verify what you actually downloaded, before showing it to anyone: \`mota-extension.json\` exists and parses, its \`"name"\` equals the folder name it will be installed as, and \`"protocolVersion"\` is 1. If any of that is wrong the extension will load as "Invalid" — say so and stop.
4. Read the permissions FROM THAT MANIFEST. The index's list is a copy for browsing; the folder you downloaded is the truth, and a difference between them is worth telling the user about.

## If they gave a URL instead

Same steps, using their URL: an https clone URL whose repository root holds the manifest. If the root has no manifest but one subfolder does, say which and ask before using it. If it is not an https git URL at all — a zip, a gist, a path on their disk — say what you can and cannot do with it rather than guessing.

## Then stop and ask — every time

Show them, before writing anything:

- the display name, version and description from the manifest;
- where it came from: the URL, and the commit (\`git rev-parse --short HEAD\` in the clone);
- every permission it declares, one line each in plain words:
  commands:register — adds slash commands ·
  tools:register — gives your agents new MCP tools ·
  events:subscribe — reacts to workbench events ·
  notifications — desktop notifications ·
  transcripts:read — reads your chat transcripts ·
  fs:project-read — reads files in your open projects ·
  ui:panel — draws a panel in the sidebar ·
  ui:theme — colour themes ·
  agent:prompt — can start agent turns, which SPENDS THE USER'S AI CREDITS ·
  shell:exec — runs programs with the user's full privileges ·
  provider:register — registers an AI provider.

Call out \`agent:prompt\`, \`shell:exec\` and \`provider:register\` explicitly and say what the extension claims to need them for (its README usually says; if it does not, that is worth saying too). Extensions run as ordinary programs under the user's account — Mota's permissions are informed consent, not a sandbox, and this is the moment the user decides whether to trust someone else's code. Ask for a yes. Do not skip this because the extension looks harmless.

## Only after they say yes

1. Create the destination folder and copy the extension into it — the contents only, without \`.git\`. The destination folder name MUST equal the manifest's \`"name"\`.
2. If that folder already exists, do not overwrite it silently: say what is installed there now (its version) and ask.
3. Delete the temporary clone.
4. Touch nothing else. You are copying one folder, not configuring the app.

## Finish by telling them how to turn it on

Settings → Extensions → **Reload list** → it appears as "Needs approval" → **Approve…**, which opens a native dialog listing exactly what it may do. Then its commands work in any chat as \`/name\` (or \`/<id>.<name>\` if the name is already taken). Debugging: Settings → Extensions → **Show log**. Uninstalling: delete the folder and reload the list.

You cannot enable it yourself and should not try — that dialog is deliberately the user's alone.`;

/**
 * The full brief, with the user's argument folded in. The slot is a
 * private token for the same reason the scaffolding guide's is: the text
 * around it is an instruction sheet, not a place to run substitutions.
 */
export function installExtensionPrompt(args: string): string {
  return INSTALL_EXTENSION_TEMPLATE.replace(
    "__USER_REQUEST__",
    args.length > 0 ? args : "(nothing — show them what the store has)",
  );
}
