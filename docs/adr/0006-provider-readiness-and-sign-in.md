# ADR-0006 — Provider readiness is earned, and sign-in is a button

- Status: accepted
- Date: 2026-08-09
- Amends: ADR-0005 (the settings probe introduced there)

## Context

The settings screen ran a short ACP handshake and reported a provider as
`authenticated: true` whenever `session/new` succeeded. The screen told
the user, in as many words, that "a green light here means it will work."

That promise was not true. The Claude adapter opens a session without
touching credentials and only authenticates when the first prompt is
sent. A user whose stored OAuth token could no longer be refreshed saw a
green light in settings and then, on their first message:

```
Failed to authenticate: OAuth session expired and could not be refreshed
Internal error: Failed to authenticate: OAuth session expired and could not be refreshed
```

Three separate failures compounded there:

1. **A false green light.** The probe reported a fact it had not checked.
2. **A raw wire error.** The adapter's JSON-RPC message reached the
   transcript verbatim, prefixed with "Internal error", which reads as an
   app bug rather than "sign in again".
3. **No way to act.** The fix is a terminal command. A desktop app whose
   remedy is "open a terminal and run `claude auth login`" has pushed its
   own problem onto the user.

A fourth, adjacent one: a macOS `.app` launched from Finder inherits
launchd's environment, whose `PATH` has no Homebrew, nvm, or volta — so
CLIs the user runs daily can be invisible to the app entirely.

## Decision

**Readiness is a four-state ladder, not a boolean.** `notInstalled` →
`signInRequired` → `started` → `ready`. The handshake can only establish
the first three; `ready` is reached when a real turn has completed for
that provider.

We considered making the probe send a one-token prompt so green would be
provable on demand. Rejected as the default: it spends the user's quota
every time the settings screen opens, for a question that answers itself
the moment they send a message. Reporting uncertainty honestly is
cheaper and no less useful.

`ready` is held in memory for the run of the app and never persisted. A
token that worked yesterday says nothing about today, and a stale green
light is the bug this ADR exists to remove.

**Login failures are classified, not forwarded.** `acp::is_auth_failure`
matches phrases these CLIs actually emit — not any mention of "auth", so
a tool named `authorize_payment` failing is not read as a login problem.
A matching turn completes with the `auth_required` stop reason and plain
words, keeping the adapter's own text underneath: that detail is what
separates an expired token from a revoked one when the user asks for
help, and support has no other copy of it.

**The app opens the vendor's login prompt; it never handles tokens.**
`sign_in::open_provider_login` launches a terminal running the vendor's
own login command (`claude auth login`, `codex login`, `gemini`). The
credential store — macOS Keychain, `~/.claude`, the CLI's own config —
belongs to the CLI. Driving the OAuth flow ourselves would mean owning
credential storage for three vendors, and being wrong about it on the
day any of them changes.

This is the one place the app builds a command string for a shell
(`osascript`, `cmd /c start`), against the argv-only rule the rest of the
codebase follows. It is safe only because every program and argument
comes from `acp::sign_in_command`, a table of compile-time constants: no
project path, prompt, or user input reaches it. That constraint is the
reason the table returns `&'static str`, and it must stay that way.

**On macOS, the login shell's environment is imported at startup.**
`shell_env::import_login_shell_env` runs `$SHELL -lic 'command env'` once
(3-second budget, falling back to the inherited environment) and imports
`PATH` plus the provider variables. Deliberately, the user's shell
profile wins: an app that silently disagreed with the terminal about
which `claude` is on `PATH`, or which `ANTHROPIC_API_KEY` is set, would
produce failures nobody could explain.

## Consequences

- The settings screen usually shows neutral, not green, until a message
  has been sent. That is the honest state and the hint says so.
- `completion_from_prompt_result` now takes the provider id, so it can
  name the CLI and its login command in the message.
- The transcript's auth error points at Settings → Providers rather than
  offering an inline button: the message rows are memoized and threading
  a callback to them was more coupling than the second click is worth.
  Worth revisiting if this turns out to be a common path.
- macOS startup can cost up to 3 seconds when a shell profile is slow.
  The window is already up; only provider resolution waits.
- Nothing here can help a machine where the CLI itself cannot
  authenticate. The app's job is to say so clearly and offer the fix,
  not to pretend it owns the problem.
