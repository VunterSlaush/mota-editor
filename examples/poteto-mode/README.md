# Poteto Mode for Mota Editor

A pure-data extension that brings a rigorous agent mode to Mota. It is an
adaptation of [pstack](https://github.com/cursor/plugins/tree/main/pstack)
by Lauren Tan (MIT), the Cursor plugin behind `/poteto-mode`.

Type `/poteto-mode <goal>` in any chat. The agent reads a principles
index, matches your goal to a playbook, copies the playbook's steps into
its todo list, delegates bounded steps to sub-agents by model tier, and
reports done only with verbatim evidence. The mode is sticky by
instruction: "continue" resumes the playbook, "new task" re-matches, and
"exit poteto mode" turns it off.

## Commands

| Command | What it does |
|---|---|
| `/poteto-mode <goal>` | The front door. Principles, playbook match, todo list, tiered delegation, evidence before done. |
| `/how <subsystem>` | Walk through how something works from real code, with file:line hops. |
| `/why <thing>` | Why it was built this way, from ADRs and git history, with sources. |
| `/architect <change>` | Design a boundary-crossing change: callers, shapes, ownership, finish check. |
| `/arena [N] <task>` | N isolated parallel attempts, judged by a separate model. |
| `/interrogate [target]` | Adversarial multi-lens review. Only confirmed findings survive. |
| `/tdd <bug>` | Failing test first, smallest fix, both outputs quoted. |
| `/figure-it-out <goal>` | Bespoke phased plan with checkable finish conditions. |
| `/show-me-your-work [path]` | Append a decision log a reviewer can audit. |
| `/unslop [target]` | Strip filler from code or prose without changing behavior. |

Playbooks bundled inside `/poteto-mode`: Investigation, Bug fix, Feature,
Refactoring, Performance issue, Prototype, Runtime forensics, Opening a PR,
Autonomous run, Multi-phase plan, Session pickup, Worktree cleanup.

## Install

1. Copy this folder to `~/.mota/extensions/poteto-mode/`
   (Windows: `%USERPROFILE%\.mota\extensions\poteto-mode\`), or ship it
   with a repo under `<project>/.mota/extensions/poteto-mode/`.
2. In Mota: Settings, Extensions, Reload list, then Approve. The only
   permission is `commands:register`. No process is started.
3. Optional, for Claude Code tabs: copy `agents/poteto-agent.md` into
   `<project>/.claude/agents/` or `~/.claude/agents/`. The main prompt
   then delegates implementation and investigation steps to that
   sub-agent. Without it the agent uses the harness default sub-agent and
   pastes the principles into each brief.

If a command name collides with one you already have, Mota lists it as
`/poteto-mode.<name>`, and the qualified form always works.

## What is prompt-level and what is enforced

Everything here is prompt text. Mota expands the command client-side and
sends it as the turn's prompt, so:

- The todo list is the agent's own plan tool. Mota renders it in the Plan
  panel when the provider reports it, but nothing blocks a step.
- "Evidence before done" is an instruction, not a gate. Mota has no hook
  that runs tests before a reply. If you want a hard gate, that is a
  Mota feature, not an extension.
- Model tiering depends on the harness. Claude Code's sub-agent tool
  accepts a model per agent, so tiers apply there. Codex and Gemini
  inherit the session model.
- Stickiness lives in the conversation. A fresh chat starts without the
  mode until you type `/poteto-mode` again.

## Editing

Each command is a markdown file under `prompts/`. `$ARGUMENTS` is
replaced with whatever follows the command. Edit in place and press
Reload in Settings, Extensions. Files are read whole, so do not add YAML
frontmatter to them.
