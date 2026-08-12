---
name: create-mota-extension
description: Scaffold a Mota Editor extension from a plain-language description — manifest, script, install, and test steps
---

# Create a Mota Editor extension

You are scaffolding an **extension for Mota Editor** (the AI-agent
workbench). An extension is a folder containing a `mota-extension.json`
manifest and, only when it needs dynamic behavior, one executable script
in any language speaking JSON-RPC over stdio. Full reference:
`docs/EXTENSIONS.md` in the Mota repository
(https://github.com/VunterSlaush/mota-editor — but this skill is
self-contained; everything needed is below).

## Step 1 — understand what the user wants

Ask (unless already clear from their request):

1. What should the extension do, in one sentence?
2. A short id for it (`[a-z0-9-]`, 2–64 chars, e.g. `standup`).
3. Which of these does it need? Pick the MINIMUM:
   - A **prompt command** — a reusable prompt template behind `/name`.
     Pure data, no code, no process. Prefer this whenever possible.
   - A **programmatic command** — `/name` runs their script, which can
     notify, fill the composer, or start an agent turn.
   - **Agent tools (MCP)** — new tools the AI agents can call.
   - **Event automation** — react to `turn/completed` etc. (note: the
     host delivers events in a later Mota version; scaffold it, but say so).

## Step 2 — scaffold the folder

Create `~/.mota/extensions/<id>/` (Windows: `%USERPROFILE%\.mota\extensions\<id>\`).
The folder name MUST equal the manifest `name`.

### The manifest (`mota-extension.json`)

```json
{
  "name": "<id>",
  "version": "0.1.0",
  "displayName": "<Human Name>",
  "description": "<one line — shown in Settings and the consent dialog>",
  "protocolVersion": 1,
  "entry": { "command": "node", "args": ["./main.js"] },
  "permissions": [],
  "contributes": { "commands": [], "mcpServers": [], "events": [] }
}
```

Rules the host enforces (violations show as "invalid" in Settings):

- Omit `entry` entirely for pure prompt-command/data extensions.
- Every contribution needs its permission: commands →
  `"commands:register"`, MCP servers → `"tools:register"`, events →
  `"events:subscribe"`. Host-API calls need theirs: `"notifications"`
  for `host/notify`. Declare ONLY what is used — the user approves this
  exact list in a native dialog, and any later change re-asks.
- Command shapes:
  - Prompt: `{ "name": "x", "kind": "prompt", "description": "...",
    "argsHint": "[optional]", "template": "... $ARGUMENTS ..." }`
    (`$ARGUMENTS` is replaced with whatever follows the command; without
    the marker, arguments are appended). `"file": "./cmd.md"` may replace
    `template` — relative, inside the folder, no `..`.
  - Programmatic: `{ "name": "x", "kind": "programmatic", "description": "..." }`
    — requires `entry`.
- MCP server: `{ "name": "tools", "command": "node", "args": ["./mcp.js"] }`
  — a separate ordinary MCP server process; paths naming files in the
  extension folder are resolved to absolute automatically.

### The script (only if `entry` is declared)

The protocol is: read one JSON object per stdin line, write one per
stdout line (JSON-RPC 2.0). stderr goes to the extension's log. This
Node template is complete — adapt the `command/execute` branch:

```js
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    reply(msg.id, { protocolVersion: 1 });
  } else if (msg.method === "command/execute") {
    const { command, args, context } = msg.params; // context: {tabId, projectPath}
    reply(msg.id, { actions: [
      // Any of (each capped, unknown types ignored):
      // { type: "notify", title: "...", message: "..." }        needs "notifications"
      // { type: "insertPrompt", text: "..." }                   fills the composer
      // { type: "startTurn", prompt: "..." }                    needs "agent:prompt" ⚠ spends credits
    ]});
  } else if (msg.method === "shutdown") {
    process.exit(0);
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id,
           error: { code: -32601, message: "Unknown method: " + msg.method } });
  }
});
```

Other facts your script can rely on: `initialize` params carry
`grantedPermissions`, `projectPaths`, and `dataDir` (a scratch folder
that persists — keep state there). You may send
`{"jsonrpc":"2.0","method":"host/log","params":{"message":"..."}}`
anytime (no permission needed) and call `host/notify` as a request.
Command-only extensions are shut down after ~5 idle minutes and rebooted
on the next use — do not rely on in-memory state across commands.

## Step 3 — tell the user how to test it

1. In Mota: Settings → Extensions → **Reload list**. The extension
   appears with status "Needs approval".
2. Click **Approve…** — a native dialog lists the declared permissions.
3. Type `/<command>` in any chat. (If the name clashes with a builtin or
   another extension, it appears as `/<id>.<command>` instead.)
4. Debug via Settings → Extensions → **Show log** (stderr + `host/log`).
   Three crashes within a minute quarantine the extension until re-enabled.

## Judgment calls

- Prefer a prompt command over a script — zero process, zero risk, and
  the consent dialog stays friendly.
- Request the smallest permission set that works; `agent:prompt` and
  `shell:exec` show warning badges to the user.
- If the user asks for event automation (`turn/completed` and friends) or
  `host/exec`/`host/fs`, scaffold the subscription/manifest honestly but
  tell them current Mota versions answer those host calls with
  "not implemented yet" — the contribution activates when the host does.
