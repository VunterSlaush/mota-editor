# Jev for Mota Editor

Gives your agents [Jev](https://typesafe.ai), TypeSafe AI's "System One"
classifier, as an MCP tool. Jev does not write text: it takes a *state*
(a string, a JSON object or an array) and a set of typed questions, and
answers all of them in one pass with calibrated probabilities — usually
in 70–500 ms, at a few cents per million input tokens.

The agent gets one tool, `jev_ask`:

| Question type | Answer |
|---|---|
| `noul` | probability the answer is yes |
| `choice` | the picked option from `criteria` (option → description), with probabilities |
| `score` | a level from `criteria` (an array, lowest first), with probabilities |

This is separate from Mota's own Jev integration (Settings → Jev), which
gates tool calls and judges finished turns without the agent's
involvement. This extension is for the agent's *own* use.

## Install

1. Copy this folder to `%USERPROFILE%\.mota\extensions\jev\` (Windows) or
   `~/.mota/extensions/jev/` — or link it there while developing:
   `mklink /J %USERPROFILE%\.mota\extensions\jev <repo>\examples\jev`.
2. **Settings → Extensions → Jev → Enable**, and approve the two
   permissions: `tools:register` (the MCP tool) and `ui:panel` (the
   sidebar panel).
3. Open the **Jev** panel in the activity bar, paste your TypeSafe API
   key into the field and press Enter. **Test** makes one tiny call to
   prove the key and the network both work.

The key is stored in this folder's `config.json` (owner-only on macOS
and Linux). `TYPESAFE_API_KEY` in the environment takes precedence. If
you install the extension inside a project, keep `config.json` out of
git — the repo's own `.gitignore` already does this for `examples/jev/`.

## Try it

Start a **new chat** (the agent picks up tool servers when its session
is created), then ask something like:

> Before you run anything, use jev_ask to rate how destructive
> `git clean -fdx` would be in this repo, and how likely it is to delete
> something I would want back. Then tell me what you would do instead.

## Troubleshooting

- **The tool is missing.** Tools arrive with a new chat — the running
  session keeps the server list it started with. Settings → Tools shows
  the extension's server; its probe should report *1 tool*.
- **`node` not found.** The agent CLI spawns `node main.cjs --mcp`, so
  Node 18 or newer must be on the PATH the agent sees.
- **"No Jev key."** Save one in the Jev panel, or set `TYPESAFE_API_KEY`
  and restart Mota.
- **"Jev rejected the key (401)."** The key is wrong or revoked; paste a
  fresh one, or press **Forget key** and set the environment variable.
