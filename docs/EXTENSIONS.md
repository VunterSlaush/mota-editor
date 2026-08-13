# Writing a Mota extension

An extension is **a folder**: a `mota-extension.json` manifest plus,
optionally, an executable in any language. Install one by dropping the
folder into `~/.mota/extensions/<id>/` (or ship it with a repo under
`<project>/.mota/extensions/<id>/`), then enable it in Settings →
Extensions. Enabling shows a native dialog listing exactly what the
extension may do; extensions run with your user account — the permission
model is informed consent, not a sandbox (ADR-0012).

A complete working example lives in [`examples/standup/`](../examples/standup/).

Don't want to write it by hand? Two prompt-driven routes:

- **In Mota itself** (any install): type `/create-extension` in any chat
  and describe what you want — the command is built into the app and
  expands into a full scaffolding brief for whichever agent the tab runs.
- **In plain Claude Code**: the repo ships the same brief as an agent
  skill, [`.claude/skills/create-mota-extension/`](../.claude/skills/create-mota-extension/SKILL.md);
  copy the folder into `~/.claude/skills/` to have `/create-mota-extension`
  in every project.

## The manifest

```json
{
  "name": "standup",
  "version": "0.1.0",
  "displayName": "Standup",
  "description": "Daily standup notes from your agent sessions.",
  "protocolVersion": 1,
  "entry": { "command": "node", "args": ["./main.js"] },
  "permissions": ["commands:register", "notifications"],
  "contributes": {
    "commands": [
      { "name": "standup", "kind": "prompt", "description": "Draft a standup update",
        "argsHint": "[days]", "template": "Summarize the last $ARGUMENTS days of work." },
      { "name": "standup-notify", "kind": "programmatic",
        "description": "Ping me when the draft is ready" }
    ],
    "mcpServers": [],
    "events": []
  }
}
```

| Field | Meaning |
|---|---|
| `name` | The extension id. `[a-z0-9-]`, 2–64 chars, **must equal the folder name**. |
| `version` | Yours; shown in Settings. |
| `protocolVersion` | `1`. A manifest requiring a newer protocol is listed as incompatible, never partially loaded. |
| `entry` | How to start your process: `command` resolves inside the extension folder first, then on PATH — never in the project. Omit it entirely for pure-data extensions (prompt commands need no process). |
| `permissions` | Everything you intend to do, from the table below. Unknown strings fail closed. Changing this set sends the extension back to needs-approval. |
| `contributes.commands` | Slash commands. `kind: "prompt"` is pure data — a `template` (or `file` relative to your folder) expanded client-side, `$ARGUMENTS` replaced (or the arguments appended, matching Claude custom commands). `kind: "programmatic"` routes to your process. |
| `contributes.mcpServers` | MCP servers handed to the user's agents, riding the app's existing MCP plumbing. Paths naming files in your folder are resolved to absolute. |
| `contributes.panels` | Sidebar panels: `{ "id": "tasks", "title": "Linear", "icon": "checklist" }`. The host draws the activity-bar icon and asks your process for a declarative view model — see [Panels](#panels). Requires `ui:panel` and an `entry`. |
| `contributes.events` | Workbench events you want pushed (`turn/completed`, `project/opened`, `project/closed`, `app/started`). Subscribers stay resident; command-only extensions are reaped when idle. |
| `idleTimeoutMs` | Optional idle-shutdown override (capped at 30 min). |

Unknown manifest fields are ignored, so manifests can evolve additively.

### Permissions

| Permission | Grants | |
|---|---|---|
| `commands:register` | contributing slash commands | |
| `tools:register` | contributing MCP servers | |
| `events:subscribe` | receiving workbench events | |
| `notifications` | `host/notify` | |
| `transcripts:read` | `host/transcripts/read` | |
| `agent:prompt` | `agent/prompt`, `commands/run` | ⚠ spends the user's AI credits |
| `fs:project-read` | `host/fs/read` (confined to open projects) | |
| `ui:panel` | contributing sidebar panels | |
| `ui:theme` | color themes (later phase) | |
| `shell:exec` | `host/exec` | ⚠ full user privileges |
| `provider:register` | registering an AI provider (later phase) | ⚠ |

Command naming: your commands appear as `/name`. If a builtin or another
extension claims the same name, yours is listed as `/<id>.<name>` — the
qualified form always resolves either way. Extension commands shadow
same-named project/user command files; builtins always win.

## The wire protocol (MXP v1)

JSON-RPC 2.0, one JSON object per line, over your process's stdin/stdout.
stderr goes to the extension's log (Settings → Extensions → Show log).
Rules: answer requests by `id`; ignore notifications you don't know;
answer requests you don't know with error `-32601`. The host does the same.

The host calls you:

| Method | Kind | Params → Result |
|---|---|---|
| `initialize` | request | `{protocolVersion, hostVersion, extensionId, grantedPermissions, dataDir, projectPaths}` → `{protocolVersion: 1}`. Must be answered within 10 s. `dataDir` is a scratch folder that is yours to keep state in. |
| `command/execute` | request | `{command, args, context: {tabId, projectPath}}` → `{actions: [...]}` (30 s budget) |
| `panel/load` | request | `{panelId, context}` → `{view}` — see [Panels](#panels) (30 s budget) |
| `panel/action` | request | `{panelId, action, itemId, value?, context}` → `{view?, detail?}` (30 s budget) |
| `event/emit` | notification | `{event, payload}` |
| `shutdown` | notification | flush and exit; the process is killed ~3 s later |
| `ping` | request | `{}` → `{}` |

You call the host (each gated by a permission, above):

| Method | Kind | Params |
|---|---|---|
| `host/log` | notification | `{message}` — lands in your log |
| `host/notify` | request | `{title, body}` → `{}` |
| `panels/refresh` | request | `{panelId?}` → `{}` — "my data changed, re-pull me"; the host re-loads the panel only if it is open |
| `host/transcripts/read`, `host/fs/read`, `host/exec`, `agent/prompt`, `commands/run` | request | reserved — the host currently answers with an error naming them unimplemented; they arrive in later phases |

`command/execute` answers with an **action list** — the whole vocabulary
of what a command may do:

```json
{ "actions": [
  { "type": "notify", "title": "Standup", "message": "Draft ready." },
  { "type": "insertPrompt", "text": "Fills the composer with this text." },
  { "type": "startTurn", "prompt": "Runs this as an agent turn (needs agent:prompt)." }
] }
```

A full transcript of one session:

```
← {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"extensionId":"standup","grantedPermissions":["commands:register","notifications"],"dataDir":"...","projectPaths":["G:/repo"],"hostVersion":"0.1.0"}}
→ {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}
← {"jsonrpc":"2.0","id":2,"method":"command/execute","params":{"command":"standup-notify","args":"","context":{"tabId":"t1","projectPath":"G:/repo"}}}
→ {"jsonrpc":"2.0","method":"host/log","params":{"message":"building the draft"}}
→ {"jsonrpc":"2.0","id":2,"result":{"actions":[{"type":"notify","title":"Standup","message":"Ready."}]}}
```

## Panels

A panel (ADR-0013) is **declarative data the host renders** — your
process never draws anything, it answers `panel/load` with a view model
in a closed vocabulary and the app renders it with its own components,
themed like everything else:

```json
{ "view": {
  "emptyText": "Shown when there are no groups — say what to do about it.",
  "groups": [
    { "title": "In Progress", "items": [
      { "id": "iss-1", "title": "Fix login", "subtitle": "ENG-123",
        "badge": "Urgent",
        "select": { "selectedId": "started", "options": [
          { "id": "todo", "label": "Todo" },
          { "id": "started", "label": "In Progress" } ] } }
    ] }
  ] } }
```

Interactions come back as `panel/action` with a host-owned vocabulary of
two: `"open"` (the item was clicked — answer `{detail}` and the host
shows a modal) and `"select"` (the item's dropdown changed to `value` —
answer `{view}` with the updated model). A detail is
`{title, subtitle?, fields: [{label, value}], body?, url?}`; `body` is
markdown, `url` gets an open-in-browser button (http/https only).

The host validates and caps everything (20 groups, 100 items each,
50 select options, text lengths); what it does not recognize it drops,
so the vocabulary can grow without breaking you. Sizes beyond the caps
are silently truncated — page in your process if you have more. The
refresh button re-sends `panel/load`; send `panels/refresh` yourself
when your data changes behind the user's back. A working example:
[`examples/linear/`](../examples/linear/) — your Linear issues grouped
by status, with inline status changes.

## Lifecycle

Your process starts lazily — the first used contribution boots it — and a
command-only extension is shut down after ~5 minutes idle (you'll get
`shutdown`; the next command boots you again). Event subscribers stay
resident. A crash fails pending calls and restarts on the next trigger;
three crashes within a minute quarantine the extension until the user
re-enables it, with your stderr tail shown in Settings.

## Debugging

Print to stderr or send `host/log`; both land in the per-extension log
file behind Settings → Extensions → Show log. Edit your folder in place
and use the Reload button (a manifest permission change will re-ask for
consent — by design).

## Packaging and versioning

v1 packaging is a folder — zip it, share it, drop it in. Protocol
evolution is additive under `protocolVersion: 1`; a manifest demanding a
newer protocol or an unknown permission is listed as incompatible rather
than half-loaded, so targeting version 1 is always safe.
