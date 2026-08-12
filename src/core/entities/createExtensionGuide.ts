/**
 * Entities layer — the built-in `/create-extension` command: a prompt
 * template that turns the user's one-line idea into a full scaffolding
 * brief for whatever agent the tab runs.
 *
 * This ships INSIDE the app (unlike the repo's authoring docs and the
 * downloadable skill) so every install can create extensions, not just
 * people who cloned the source. It never reaches the agent as a slash
 * command — SendPrompt expands it client-side, exactly like an
 * extension's own prompt commands.
 */
export const CREATE_EXTENSION_COMMAND = "/create-extension";

export const CREATE_EXTENSION_DESCRIPTION =
  "Scaffold a Mota extension from a description";

const CREATE_EXTENSION_TEMPLATE = `You are scaffolding an extension for Mota Editor (the app this chat runs in). An extension is a folder in the user's home directory — \`~/.mota/extensions/<id>/\` (Windows: \`%USERPROFILE%\\.mota\\extensions\\<id>\\\`) — containing a \`mota-extension.json\` manifest and, ONLY if it needs dynamic behavior, one executable script speaking JSON-RPC over stdio.

What the user wants: __USER_REQUEST__

If that description is empty or unclear, ask what the extension should do before writing anything.

## Rules

1. Pick a short id, \`[a-z0-9-]\`, 2-64 chars. The folder name MUST equal the manifest "name".
2. Prefer the simplest contribution that works:
   - A PROMPT COMMAND (a reusable prompt template behind /name) is pure data — no script, no process. Choose this whenever the idea is "a prompt I keep retyping".
   - A PROGRAMMATIC COMMAND runs the extension's script, which answers with actions.
   - MCP SERVERS add tools the AI agents can call (an ordinary MCP server process).
3. Declare ONLY the permissions actually used — the user approves the exact list in a native dialog, and any later change re-asks. Vocabulary: commands:register (any commands), tools:register (MCP), events:subscribe, notifications (host/notify), agent:prompt (startTurn action — warns the user it spends credits).

## Manifest shape

{
  "name": "<id>",
  "version": "0.1.0",
  "displayName": "<Human Name>",
  "description": "<one line, shown in the consent dialog>",
  "protocolVersion": 1,
  "entry": { "command": "node", "args": ["./main.js"] },
  "permissions": ["commands:register"],
  "contributes": {
    "commands": [
      { "name": "x", "kind": "prompt", "description": "...", "argsHint": "[optional]",
        "template": "... $ARGUMENTS is replaced with what follows the command ..." },
      { "name": "y", "kind": "programmatic", "description": "..." }
    ],
    "mcpServers": [ { "name": "tools", "command": "node", "args": ["./mcp.js"] } ]
  }
}

Omit "entry" entirely for pure prompt-command extensions. Programmatic commands require it.

## Script template (only when "entry" is declared) — plain Node, no dependencies

const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    reply(msg.id, { protocolVersion: 1 });
  } else if (msg.method === "command/execute") {
    const { command, args, context } = msg.params; // context: {tabId, projectPath}
    reply(msg.id, { actions: [
      // { type: "notify", title: "...", message: "..." }   needs "notifications"
      // { type: "insertPrompt", text: "..." }              fills the composer
      // { type: "startTurn", prompt: "..." }               needs "agent:prompt"
    ]});
  } else if (msg.method === "shutdown") {
    process.exit(0);
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Unknown method" } });
  }
});

Facts the script can rely on: initialize params carry grantedPermissions, projectPaths, and dataDir (a persistent scratch folder — keep state there, not in memory: idle command-only processes are shut down after ~5 minutes and rebooted on the next use). Debug output: print to stderr, or send {"jsonrpc":"2.0","method":"host/log","params":{"message":"..."}}.

## Deliver

1. Create the folder and files in the user's home extensions directory (ask before overwriting anything that exists).
2. Show the user the manifest and explain each requested permission in one line.
3. Tell them how to activate it: Settings → Extensions → Reload list → Approve… (native dialog) → type /<command> in any chat. If the name clashes with a builtin or another extension it appears as /<id>.<command>. Logs: Settings → Extensions → Show log.`;

/**
 * The full brief for the agent, with the user's request folded in. The
 * slot is a private token rather than \`$ARGUMENTS\` because the guide
 * TEACHES that marker — a generic replace would rewrite the lesson.
 */
export function createExtensionPrompt(args: string): string {
  return CREATE_EXTENSION_TEMPLATE.replace(
    "__USER_REQUEST__",
    args.length > 0 ? args : "(nothing given — ask them)",
  );
}
