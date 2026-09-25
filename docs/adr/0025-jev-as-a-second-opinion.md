# ADR-0025 — Jev as a second opinion on the agent

- Status: accepted
- Date: 2026-09-23
- Relates to: ADR-0004 (modes and permissions — Bypass is the app's policy,
  which is what makes a second opinion on it legitimate), ADR-0005 (ACP
  sessions — the permission requests being gated), ADR-0006 (provider
  readiness — until now the app held no secret of its own), ADR-0012
  (extensions — the Rust-owned-file trust model the key follows),
  ADR-0014 (subtask scopes — the ceiling Jev never raises), ADR-0022 (the
  plan card, which Jev never touches)

## Context

Mota's permission tiers are blunt at both ends. Bypass and Auto approve
everything the agent asks about, including the one `git clean -fdx` in a
hundred reads. Manual asks about everything, and the loudest requests are
the safe ones — greps and file reads the user approves on reflex, which is
how the one that matters gets approved on reflex too. The vendors' own auto
tiers (Claude's native `auto`) sit in the middle, but they are opaque: the
app cannot see or tune what they call risky, and only one vendor has one.

Jev, TypeSafe AI's "System One" model, answers fixed questions about a
state with calibrated probabilities in 70–500 ms, for about $0.04 per
million input tokens. It does not generate text, so it cannot be talked
into doing anything; it can only answer the questions it is asked. That is
the shape of a second opinion.

## Decision

1. **Jev is a second opinion, never an authority.** It has exactly two
   powers: turn an automatic approval into a question (under Bypass/Auto),
   and turn a question into an approval when it is nearly certain the call
   is harmless (under the new `jev-auto` tier). Every failure — no key, no
   curl, a timeout, any 4xx/5xx, a malformed reply — restores today's
   behaviour for that one request: Bypass/Auto approve, `jev-auto` asks.
2. **Plans and elicitations are untouched.** A plan approval is the user's
   call whatever the policy (ADR-0022), and an elicitation is a question
   only the user can answer; neither reaches Jev.
3. **The questions and thresholds are named constants** in
   `agent_core::jev` — four yes/no gate questions (`destructive`,
   `irreversible`, `out_of_scope`, `opaque`), `RISKY_THRESHOLD` 0.60 and
   `SAFE_THRESHOLD` 0.15 — tested against real `jev-1.13.0` JSON. The
   decision is pure: the highest of the four is compared to the thresholds.
   The state Jev sees is the call's title, kind and compacted input, the
   project path, the turn's prompt as the task, and the tab's scope, capped
   at 8 KB.
4. **Transport is the system `curl`**, spawned through `runner::os_command`
   like `git` (ADR-0007). The key lives in a Rust-owned, owner-only curl
   config file (`<app_config_dir>/jev-key.curlrc`, passed as `-K`): never on
   argv, never readable by the webview, which can save or remove it but not
   read it back. `TYPESAFE_API_KEY` is the fallback, copied into a per-call
   private temp file because curl before 8.3 cannot read an environment
   variable itself. Keys are restricted to a token charset, since a newline
   in a curl config file would add options.
5. **The gate toggle rides the turn** (`StartTurnArgs.jev_gate`, held in a
   `TurnPolicy`), and the fourth permission is `jev-auto`: ask by default,
   with Jev approving the clearly safe. Without the gate `jev-auto` is
   Manual, in the reducer (so the UI never shows a tier not in force) and in
   Rust (so a stale request cannot use one). The scope cap is applied first
   and stays the ceiling.
6. **The post-turn judge is advisory UI only**: three yes/no questions
   (completed as asked / claims success without evidence / leaves
   follow-ups) become a badge on the prompt and, when concerning, the tab's
   attention flag. It never blocks, retries once on 429/529, and a verdict
   for a prompt no longer on screen is dropped.
7. **The agent-facing tool ships as an extension** (`examples/jev/`), not
   core: an MCP server giving the agent `jev_ask`. It is the agent's tool,
   not the harness's, and the extension system already carries exactly
   that.

The reader loop never waits on the network: a gated request is registered
as pending first, then judged in a spawned task. A cancel that lands while
Jev thinks answers the agent itself, and the task finds nothing left to
answer, so the agent never hears twice.

## Consequences

- **Every automatic approval costs a round trip when the gate is on** —
  bounded by curl's 4 s limit and a 5 s hard ceiling, typically under half
  a second. An agent doing hundreds of reads under Bypass pays that
  hundreds of times.
- **Jev being down is invisible except in Settings.** That is the price of
  "failure restores today's behaviour": nothing in the chat says a call
  went unjudged. Settings → Jev shows whether a key is configured and
  whether curl was found.
- **The app now holds a secret.** One file, owner-only on Unix; on Windows
  it relies on the per-user ACL of `%APPDATA%`. DPAPI is a later hardening.
- **Thresholds will need tuning.** That is a constant change and a test
  update, not an architectural one.
- **Git-for-Windows' curl uses its own CA bundle.** Behind a TLS-inspecting
  corporate proxy it may fail the handshake — which is `Unavailable`, which
  is today's behaviour. `HTTPS_PROXY` is honoured. Minimal Linux containers
  may have no curl at all; same outcome.
- **Headless runs ignore `jev-auto`** (they make no permission requests to
  intercept) and treat it as Manual.

## Alternatives considered

- **`reqwest` + `rustls`.** A TLS stack, and its transitive dependencies,
  for one endpoint — in an app whose size is the product.
- **`tauri-plugin-http`.** Same weight, and it would open network access
  toward the webview, which the CSP deliberately forbids.
- **Asking the agent's own model.** It is the party being judged, it is
  slower and dearer by orders of magnitude, and it can be argued with.
- **A local rules table** (regexes for `rm -rf`, `push --force`, …).
  Brittle across shells, quoting and MCP tools whose arguments say
  "delete" in their own words; Jev reads the call the way a person would.
- **A global toggle in Rust `State`.** It would change the rules of a turn
  already running and would need its own persistence; the frontend already
  persists settings and already sends a request per turn.
