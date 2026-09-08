/**
 * Entities layer — the built-in `/update-extensions` command: the other
 * end of [`installExtensionGuide`](./installExtensionGuide.ts).
 *
 * Updating IS replacing a folder's contents, so the same reasoning holds:
 * the agent already has git and a filesystem, and the app needs no
 * updater of its own. What it does need is the discipline install has —
 * an update is somebody else's new code, and a manifest that asks for one
 * more permission drops the extension back to "Needs approval", which the
 * user should hear BEFORE they say yes rather than discover afterwards.
 *
 * Ships INSIDE the app, and never reaches the agent as a slash command:
 * SendPrompt expands it client-side.
 */
import { STORE_REGISTRY_URL, STORE_REPO_URL } from "./extensionStore";

export const UPDATE_EXTENSIONS_COMMAND = "/update-extensions";

export const UPDATE_EXTENSIONS_DESCRIPTION =
  "Check installed extensions against the store and update them";

const UPDATE_EXTENSIONS_TEMPLATE = `You are updating the user's installed Mota Editor extensions (Mota is the app this chat runs in).

What they asked for: __USER_REQUEST__

An installed extension is a folder: \`~/.mota/extensions/<id>/\` (Windows: \`%USERPROFILE%\\.mota\\extensions\\<id>\\\`) for the user's own, and \`<project>/.mota/extensions/<id>/\` for the ones a repo ships. Each holds a \`mota-extension.json\` whose \`"version"\` is what is installed. There is no package manager and nothing to build — updating one IS copying a newer folder over it.

The store is ${STORE_REPO_URL} and its index is
${STORE_REGISTRY_URL}

## 1. Take stock on disk first

List the folders in the user extensions directory, and in the open project's \`.mota/extensions/\` when it has one. Read each \`mota-extension.json\` for its \`"name"\`, \`"version"\` and \`"permissions"\`. If the user named specific extensions, look only at those; otherwise look at all of them.

## 2. Compare against the index

Read the index (fetch that URL, or \`curl -fsSL\` it). Entries carry \`"id"\`, \`"version"\` and \`"source"\`; match on the id.

- The index's version is newer → an update is available. Compare the dot-separated numbers as numbers; a longer or alphabetically larger string is not a newer version.
- Same version → up to date. Say so and re-download nothing to make sure.
- No entry with that id → it did not come from the store (scaffolded locally, or cloned from someone's URL). Leave it alone. If its folder is a git clone you may OFFER \`git pull\` there, but ask first and never run it unasked.
- The index cannot be reached → say so plainly, give them the store URL, and stop. Do not invent versions.

Show the whole picture before changing anything: one row per extension — id, installed version, store version, and whether it is up to date, updatable, or not in the store. If nothing is updatable, say that and stop; there is nothing to ask about.

## 3. Then stop and ask — every time

For each extension you propose to update, show:

- the display name, and \`installed → new\` version;
- where the new copy comes from: the URL, and (once cloned) \`git rev-parse --short HEAD\`;
- what the NEW manifest declares in \`"permissions"\`, one line each in plain words:
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

Call out every permission the installed version does NOT already have, and say what the new version claims to need it for. A widened permission set means Mota drops the extension back to "Needs approval" until the user answers the native consent dialog again — tell them that before they agree, not after.

An update is new code from someone else running under the user's account; Mota's permissions are informed consent, not a sandbox. Ask for a yes. Do not skip this because the version bump looks small.

## 4. Only after they say yes — one extension at a time

1. Clone into a temporary directory:
   - \`"source": {"kind": "path"}\` — \`git clone --depth 1 ${STORE_REPO_URL}.git\`; the folder is \`<temp>/extensions/<id>\`.
   - \`"source": {"kind": "git"}\` — \`git clone --depth 1 <source.url>\` (add \`--branch <source.ref>\` when the entry has one); the clone root is the folder.
2. Verify what you downloaded before it goes near the install: \`mota-extension.json\` exists and parses, its \`"name"\` equals the installed folder's name, \`"protocolVersion"\` is 1, and its \`"version"\` is the one the index promised. Anything off — say so and skip that extension rather than installing it.
3. Copy the new contents OVER the installed folder, without \`.git\`. Do NOT delete the folder first: an extension may keep its own config or data in there (a \`config.json\` holding a token, for example), and files it wrote are not yours to remove. Overwrite what the new version ships and leave everything else; if the new version drops a file the old one shipped, say so rather than deciding for them.
4. If a file cannot be overwritten because the extension is running, that is what happened — tell them to disable it in Settings → Extensions, then retry.
5. Delete the temporary clone. Touch nothing else: you are replacing folders, not configuring the app.

## 5. Finish by telling them what to do in the app

Settings → Extensions → **Reload list** picks up the new version. If the permissions widened, the row reads "Needs approval" — **Approve…** opens the native dialog listing exactly what it may now do. Debugging: **Show log**. Rolling back means reinstalling the old version, so mention the previous version number in your summary.

You cannot enable or approve anything yourself and should not try — that dialog is deliberately the user's alone.`;

/**
 * The full brief, with the user's argument folded in. Same private slot
 * as the sibling guides: the text around it is an instruction sheet, not
 * a place to run substitutions.
 */
export function updateExtensionsPrompt(args: string): string {
  return UPDATE_EXTENSIONS_TEMPLATE.replace(
    "__USER_REQUEST__",
    args.length > 0 ? args : "(nothing — check every installed extension)",
  );
}
