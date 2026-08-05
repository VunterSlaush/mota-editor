# ACP communication review — August 2026

- Status: findings for decision (no code changed by this review)
- Branch: `review/acp-communication`
- Scope: how mota-editor speaks the Agent Client Protocol (ACP), reviewed for **protocol
  completeness** and **reliability & perf**, compared against Zed (reference client),
  opencode, and Warp (UX patterns only).
- Method: codebase audit at commit `5cad9da` (`src-tauri/agent-core/src/acp.rs`,
  `src-tauri/src/acp_session.rs`, `src/core`, `src/ui`), ACP spec at
  agentclientprotocol.com (protocol v1), public source/docs of the comparison clients,
  all read 2026-08-05: Zed `zed-industries/zed@8287854` (main), opencode
  `anomalyco/opencode` (`dev` branch, formerly sst/opencode) + opencode.ai docs +
  DeepWiki, Warp via docs.warp.dev and warp.dev blogs (closed source).

## 1. Tool-call fidelity

**Findings**

- `translate_update` reduces a `tool_call` to `{ name: kind, detail: title[..200] }`
  (`acp.rs:610-661`). Discarded: `toolCallId`, `status`, `content[]` (including `diff`
  blocks with old/new text and embedded terminals), `locations`, `rawInput`, `rawOutput`.
- `tool_call_update` is not matched at all — it falls into the catch-all `_ => Vec::new()`
  (`acp.rs:647`). Tool rows never progress to completed/failed, and results/diffs never
  arrive. The test `tool_call_updates_become_tool_use_events` (`acp.rs:1055`) actually
  feeds a `tool_call`, so the gap has misleading test coverage.
- Non-text content blocks (image, audio, `resource`, `resource_link`) in message/thought
  chunks are silently swallowed (`text_of`, `acp.rs:693-699`).
- Because agent-reported edits never reach the UI, `ChangesPanel`/`DiffModal` re-derive
  everything from git, triggered by a tool-name-substring heuristic
  (`changesFiles()`, `src/core/entities/tool.ts`) plus a 400 ms debounce.
- Domain model carries only `toolName` + one detail string (`src/core/entities/message.ts`);
  no status, output, locations, or duration can be rendered even if translated.

**What the comparison clients do**

- **Zed** (`acp_thread/src/acp_thread.rs`): a `ToolCall` entity keeps id, label, kind,
  status (`Pending / WaitingForConfirmation / InProgress / Completed / Failed / Rejected /
  Canceled`), content (`ContentBlock | Diff | Terminal`), locations, raw input/output.
  `upsert_tool_call` merges `tool_call_update`s field-by-field, appending only new text
  suffixes in place to avoid flicker, and emits a per-entry update event so only that row
  re-renders. Locations resolve to buffer positions and drive editor "follow-along".
  Rendering: status icons per `ToolKind`, expandable cards, raw input behind a
  disclosure, diffs as an embedded multibuffer diff editor, live terminals inline.
- **Warp**: agent reasoning, tool results, diffs, and command blocks all stream as blocks
  in one list; agent-run terminal blocks collapse to compact summaries, expandable on
  demand. (warp.dev block-model blog)

**Improvement options**

- **T1 (S)** — Translate `tool_call_update`: carry `toolCallId` + status through the event
  stream; UI shows spinner → check/cross on tool rows. Fix the mislabeled test.
- **T2 (M)** — Carry tool-call `content` and `locations`: expandable tool rows with output,
  agent-reported diffs rendered in the existing DiffModal, "open file at line" from locations.
- **T3 (M)** — Replace the git-polling heuristic with ACP diffs/locations as the primary
  signal (git stays as fallback for non-ACP turns).
- **T4 (S)** — Stop swallowing non-text chunks: render at least a placeholder
  ("[image]", resource link) instead of losing the event.

## 2. Capabilities & negotiation

**Findings**

- Client advertises `fs: { readTextFile: false, writeTextFile: false }` and
  `terminal: false` (`acp.rs:143-144`); every `fs/*` and `terminal/*` request is answered
  `-32601` (`acp.rs:394-397`). Deliberate per ADR-0005 ("agents do their own file I/O"),
  but it forfeits unsaved-buffer reads, editor-mediated writes, and live terminal streams.
- The `initialize` response is barely read: `protocolVersion` never checked
  (`PROTOCOL_VERSION = 1` asserted unilaterally, `acp.rs:18`), `agentCapabilities` /
  `promptCapabilities` ignored — `resource_link` attachments and the non-baseline
  `session/list` are sent regardless of agent support.
- `session/new` result: only `sessionId` is read; `modes`, `models`, `authMethods`
  discarded (`acp_session.rs:395-427`).
- `current_mode_update` is ignored (catch-all), so the Composer's mode picker can silently
  disagree with the agent's real mode — e.g. after a plan approval switches Claude out of
  plan mode. `native_mode_id` hardcodes adapter-specific mode ids (`acp.rs:118-126`).
- `clientInfo.version` hardcoded to "0.1.0" (`acp.rs:135-157`).

**What the comparison clients do**

- **opencode** (as an ACP *agent*): advertises its session extensions explicitly —
  `agentCapabilities: { loadSession: true, session: { close, fork, list, resume } }`,
  `promptCapabilities: { embeddedContext: true, image: true }`, MCP transports — which is
  exactly the negotiation surface mota-editor currently ignores; a client reading it
  could gate `session/list` and attachments correctly instead of assuming.
- **Zed** (`agent_servers/src/acp.rs`): advertises `fs` read/write true, `terminal` true,
  elicitation form+URL, and real client version. Rejects agents below a minimum
  `protocolVersion`. Stores `agentCapabilities` on the connection: prompt capabilities
  gate image pasting and embedded-context mentions in the composer; session
  capabilities decide whether the session-history UI exists at all. Modes returned by
  `session/new` populate the mode picker; `session/set_mode` is applied optimistically
  with rollback on error; incoming `current_mode_update` writes straight into the shared
  mode state before the notification reaches the thread — picker and agent can't desync.
  Its `fs` handlers are why the capability matters: reads see **unsaved editor buffers**,
  and writes are applied as buffer edits (undo-able, format-on-save, then saved) rather
  than raw disk I/O. Terminals are created through the client with an output byte limit
  and rendered live inside tool-call cards.

**Improvement options**

- **C1 (S)** — Handle `current_mode_update` → sync the Composer mode picker. Highest
  correctness value per line of code in this theme.
- **C2 (S)** — Read the `initialize`/`session/new` results: check `protocolVersion`, gate
  `session/list`/`session/load` and attachment types on advertised capabilities, use
  agent-reported modes/models instead of hardcoded ids.
- **C3 (M)** — Implement `fs/read_text_file` + `fs/write_text_file` and advertise them
  (straightforward: the backend already has full fs access; route through the shell).
- **C4 (L)** — Implement `terminal/*` and embedded-terminal rendering for live command
  output. Largest piece; depends on T2's content plumbing.

## 3. Process lifecycle & diagnostics

**Findings**

- Agent `stderr` is discarded (`Stdio::null()`, `acp_session.rs:591`) — handshake/auth
  failures surface only as "did not respond in time" after 120 s (`HANDSHAKE_TIMEOUT`,
  `acp_session.rs:26`) or 180 s (load). Wiring stderr into logs was already noted as a
  follow-up during earlier debugging.
- No feedback while waiting: `session/new` measured at ~50 s on this machine — the
  adapter boots the full Claude CLI with every MCP server; `initialize` alone is ~1 s.
  So the latency is provider-side, but the app shows nothing during it (warm-up
  is fire-and-forget and silent on failure, `warmSessions.ts`).
- On stdout EOF the session is marked dead and evicted; **no restart, no automatic
  `session/load`** — the next turn boots a fresh agent and the conversation context is
  lost silently (`acp_session.rs:609-638`).
- Sessions are never shut down on app exit (no exit hook; relies on `kill_on_drop`).
- `provider_probe.rs` re-implements the raw handshake (a second wire implementation to
  keep in sync).

**What the comparison clients do**

- **Warp**: shows a persistent "Warping…" working state with stop/queue controls and fills
  long waits with contextual tips; task panes show live plans/progress per agent; cloud
  and local runs auto-recover from transient failures with a visible "Reconnecting"
  status rather than failing the turn. No dedicated slow-startup stage UX is documented.
  (docs.warp.dev: Interacting with agents, Agents 3.0 blog, Changelog 2026)
- **opencode** (cautionary): chose "durable server + reconnecting clients" — in-flight
  turns survive client disconnects, but the reconnect half is where its bugs cluster
  (TUI hangs on dead server with unbounded retry, SSE events lost across reconnect,
  heartbeats sent but not monitored — issues #18984, #16545, #13947, #17769). Lesson:
  whatever recovery story is chosen, the reattach path needs explicit timeouts and
  event-gap handling.
- **Zed** (`agent_servers/src/acp.rs`): pipes stderr and reads it forever on a background
  task — every line goes to the log and into a debug ring; on crash the **trailing
  stderr block** is attached to the "agent exited" error the user sees. Startup races
  the handshake against process exit (crash wins with a real error; no long blind
  timeout). No auto-restart either — but a `Loading / LoadError / Connected` state
  machine shows streaming status strings ("downloading adapter…") during startup, and
  after a crash the next thread reconnects and restores the session via the agent's
  advertised `loadSession`/`resumeSession` capability, falling back to an explicit
  "resumed without history" notice.

**Improvement options**

- **L1 (S)** — Capture stderr into the app log (ring buffer per session); include the tail
  in timeout/handshake error messages. Cheapest reliability win in the review.
- **L2 (S)** — Startup progress: surface "installing adapter / booting agent / creating
  session" stages in the WorkingIndicator instead of a silent 50 s.
- **L3 (M)** — Crash recovery: on unexpected EOF, offer (or attempt) respawn +
  `session/load` of the same session id instead of silently starting fresh.
- **L4 (S)** — Kill sessions on app exit; **L5 (M)** — fold `provider_probe.rs` onto the
  `AcpSession` wire code.

## 4. Cancel / resume correctness

**Findings**

- Frontend cancel deletes the tab's event handler immediately
  (`tauriAgentGateway.ts`), so the real `completed` event is dropped — and because
  approval/question cards are only marked cancelled on `completed`
  (`chat/approvalsCancelled`), **a cancelled turn can leave cards that still look
  answerable**.
- `stopReason` collapsed to two cases (`completion_from_prompt_result`,
  `acp.rs:702-722`): `refusal` → error; `max_tokens`, `max_turn_requests`, `cancelled` →
  silent normal completion. A truncated-by-limit turn looks like success.
- Native session replay folds only user/assistant/tool/plan deltas — thoughts, usage,
  approvals, questions, and errors vanish from restored history (`history.ts`);
  native history entries fake `messageCount: 0`.
- "New session" only dispatches `chat/cleared`; the backend ACP session keeps the old
  context (`SessionHistory.startNew`).
- Backend cancel itself is solid (answers pending permissions/elicitations `cancelled`,
  8 s watchdog) — the bugs are on the frontend teardown side.

**What the comparison clients do**

- **opencode**: replay is full-fidelity by design — reasoning, tool calls with status and
  output, errors, and permission decisions are all persisted (SQLite, typed message
  parts) and replayed over ACP as per-part `session/update` notifications including
  `tool_call_update` with final states (`packages/opencode/src/acp/event.ts`). "New
  session" has no UI-clear-only concept: `/clear` is literally an alias of `/new`, always
  creating a fresh server-side session; branching is a separate explicit `fork`.
- **Warp**: exiting an in-progress conversation cancels its work behind a ~2 s
  double-confirm guard, so cancel is deliberate and its effect unambiguous.
- **Zed** (`acp_thread.rs` `cancel()`): cancel flushes streaming text, flips every
  pending/in-progress tool call to `Canceled`, and **resolves in-flight permission
  requests with `Cancelled`** before sending `session/cancel` — then still awaits the
  turn's completion. Stop reasons are all distinguished: `MaxTokens` emits a visible
  error callout; `Cancelled` cancels pending entries; `Refusal` is disambiguated (tool
  output vs. model refusal) and can truncate the refused exchange from the transcript.

**Improvement options**

- **R1 (S)** — Keep the handler until the real `completed` arrives after cancel (or
  synthesize `approvalsCancelled` on cancel). Fixes the answerable-card bug.
- **R2 (S)** — Map `max_tokens`/`max_turn_requests` to a visible info/warning row;
  treat `cancelled` explicitly.
- **R3 (M)** — Replay fidelity: fold thoughts/approvals/questions/errors in
  `ReplayedSession`; real message counts in the history list.
- **R4 (S)** — Make "new session" actually end/reset the backend session.

## 5. Permissions & safety

**Findings**

- `bypass_choice` (`acp.rs:579-585`) prefers `allow_once`, then any `allow*`, but its
  final fallback is `options.first()` — which can silently select a **reject** option.
- `is_plan_approval` (`acp.rs:596-607`) is a heuristic over Claude-specific option ids and
  the word "plan" in the title; one false positive already documented (`roofPlane`).
- Permission option hints are hardcoded local copy (`MODE_SWITCH_HINTS`,
  `src/core/entities/approval.ts`); `allow_always`/`reject_always` semantics are not
  conveyed to the user beyond button color.
- The approval card shows only the title string — no command/diff preview of what is
  actually being approved (blocked on theme 1's content plumbing).

**What the comparison clients do**

- **Warp**: per-capability autonomy matrix (apply diffs / read files / execute commands /
  MCP calls, each Agent-Decides / Always-Ask / Always-Allow / Never), regex allow/denylist
  where the denylist beats everything including "YOLO mode"; approval prompts show the
  exact command and are **editable before confirming**; "fast-forward" auto-approves the
  rest of a run once trusted. (docs.warp.dev: Agent Profiles & Permissions)
- **Zed**: permission state is part of the tool call itself
  (`ToolCallStatus::WaitingForConfirmation` carries the options and the responder), so
  the approval UI *is* the tool-call card — command, diff, or terminal preview included,
  force-expanded while waiting. A status update arriving during the prompt only updates
  the inner status; the confirmation stays coherent.

**Improvement options**

- **P1 (S)** — `bypass_choice`: never auto-pick a reject; if no allow option exists,
  surface the request to the user instead.
- **P2 (S)** — Base plan-approval detection on option `kind`/mode-switch data rather than
  title sniffing where possible.
- **P3 (M)** — Approval cards show the tool call being approved (command, diff preview);
  depends on T2.

## 6. Perf & telemetry

**Findings**

- `session/new` ≈ 50 s (measured 2026-08-05; full Claude CLI + MCP boot). `initialize`
  ≈ 1 s. Session-agnostic calls (`session/list`) already avoid `session/new`; warm-up
  hides the cost only when it wins the race and is silent when it fails.
- Token usage depends on the nonstandard `usage_update`; when an agent doesn't send it,
  the context gauge disappears and auto-compact (85% threshold, `sendPrompt.ts`) never
  fires.
- Delta buffering (33 ms) and per-bubble memoization are already in good shape.

**What the comparison clients do**

- **opencode**: tracks four token categories (input/output/reasoning/cache) on the session
  row itself, so any client can render context fill without a special event; automatic
  compaction compares tokens against the model's context window with output headroom,
  keeps recent turns within a preserve budget, LLM-summarizes the rest, and separately
  **prunes old tool outputs** once history exceeds ~40k tokens
  (`packages/opencode/src/session/compaction.ts`).
- **Warp**: a context-usage meter appears above ~20% fill and turns red near the limit;
  the conversation auto-summarizes when exceeded. (docs.warp.dev: Agent Conversations)
- **Zed**: startup latency is handled by UX, not magic — the `Loading` state streams
  human-readable install/boot status; there is no fixed long handshake timeout because
  crash detection (process-exit racing) makes failures fast instead.

**Improvement options**

- **F1 (S)** — Persist warm-session failures visibly (status chip on the tab) so a 50 s
  first turn is at least explained.
- **F2 (S)** — Fall back to client-side token estimation for the gauge when no
  `usage_update` arrives (so auto-compact still has a signal).

## 7. Error UX

**Findings**

- `errorOccurred` and failed completions render as plain error bubbles with no request
  context and no retry affordance.
- The ACP-unavailable fallback notice is emitted as a `ToolUse { name: "info" }` event
  (`commands.rs:116-128`), which lands as a `tool` row — invisible unless verbose is on.

**What the comparison clients do**

- **Warp**: auto-retries transient request errors before surfacing failure; error banners
  include the underlying error details; a management panel color-codes failed runs and
  jumps to the conversation needing input. No explicit per-message retry button is
  documented — recovery is automatic-first. (docs.warp.dev: Changelog 2026, Managing
  Agents)
- **opencode**: transient LLM errors (5xx, rate limit, overload, timeout, network) are
  auto-retried with exponential backoff honoring `retry-after`; context-overflow errors
  are routed to compaction instead of retry. Errors surface as typed objects with a
  human message and an optional clickable action, and are **persisted as message parts**
  so they replay on resume (`packages/opencode/src/session/retry.ts`).
- **Zed**: crash errors carry the trailing stderr block; `MaxTokens` gets a dedicated
  callout; auth-required errors are distinguished from generic failures and route to a
  sign-in flow.

**Improvement options**

- **E1 (S)** — Error bubbles carry context (which request/turn failed) and a "Retry"
  action that re-sends the prompt.
- **E2 (S)** — Emit the fallback notice as a real `info`-role event so it's visible by
  default.

## Decision checklist

Ordered by recommended priority (impact ÷ effort, dependencies last). Each picked item is
implemented on its own branch off `main` (e.g. `acp/tool-call-fidelity`) and tested in
isolation, per the review plan.

| Pick | ID | Improvement | Theme | Impact | Effort | Depends on |
|------|----|-------------|-------|--------|--------|------------|
| ☐ | T1 | Handle `tool_call_update` (status lifecycle on tool rows) | 1 | High | S | — |
| ☐ | L1 | Capture agent stderr into logs + error messages | 3 | High | S | — |
| ☐ | R1 | Fix cancel teardown (no answerable cards after cancel) | 4 | High | S | — |
| ☐ | C1 | Sync mode picker from `current_mode_update` | 2 | High | S | — |
| ☐ | P1 | `bypass_choice` must never auto-pick reject | 5 | Med | S | — |
| ☐ | R2 | Surface `max_tokens` / other stop reasons | 4 | Med | S | — |
| ☐ | L2 | Startup progress stages instead of silent 50 s | 3 | High | S | — |
| ☐ | C2 | Read initialize/session-new capabilities, modes, models | 2 | Med | S | — |
| ☐ | T2 | Carry tool-call content + locations to the UI | 1 | High | M | T1 |
| ☐ | T4 | Placeholders for non-text content blocks | 1 | Med | S | — |
| ☐ | E1 | Error context + retry | 7 | Med | S | — |
| ☐ | E2 | Fallback notice visible by default | 7 | Low | S | — |
| ☐ | R4 | "New session" resets the backend session | 4 | Med | S | — |
| ☐ | L3 | Crash recovery via respawn + `session/load` | 3 | Med | M | — |
| ☐ | R3 | Full-fidelity session replay | 4 | Med | M | — |
| ☐ | C3 | Implement `fs/read_text_file` / `fs/write_text_file` | 2 | Med | M | C2 |
| ☐ | T3 | ACP diffs as primary ChangesPanel signal | 1 | Med | M | T2 |
| ☐ | P3 | Approval cards preview the guarded tool call | 5 | Med | M | T2 |
| ☐ | F1 | Visible warm-session status | 6 | Low | S | — |
| ☐ | F2 | Client-side token estimation fallback | 6 | Low | S | — |
| ☐ | L4 | Kill sessions on app exit | 3 | Low | S | — |
| ☐ | P2 | Kind-based plan-approval detection | 5 | Low | S | — |
| ☐ | L5 | Unify probe onto the session wire code | 3 | Low | M | — |
| ☐ | C4 | Implement `terminal/*` + embedded terminal rendering | 2 | High | L | T2, C2 |

## Appendix A — ACP surface vs implementation

| Spec area | Status |
|-----------|--------|
| `initialize` | ✅ sent; response mostly unread (no version check, caps ignored) |
| `authenticate` | ❌ not implemented (auth errors → "sign in to the CLI" hint) |
| `session/new` | ✅; only `sessionId` read |
| `session/load` | ✅ (180 s timeout); refused mid-turn |
| `session/list` | ✅ (non-baseline extension) |
| `session/set_mode` | ✅ best-effort per turn |
| `session/prompt` | ✅ |
| `session/cancel` | ✅ + 8 s watchdog |
| `session/request_permission` | ✅ (bypass fallback flaw, see P1) |
| `elicitation/create` | ✅ form mode only (url deliberately omitted) |
| `session/update: message/thought chunks` | ✅ text only; other blocks dropped |
| `session/update: tool_call` | ⚠️ name+title only |
| `session/update: tool_call_update` | ❌ ignored |
| `session/update: plan` | ✅ |
| `session/update: available_commands_update` | ✅ (input hints dropped) |
| `session/update: current_mode_update` | ❌ ignored |
| `fs/read_text_file`, `fs/write_text_file` | ❌ declared unsupported |
| `terminal/*` | ❌ declared unsupported |
| Capability negotiation | ❌ not performed |

## Appendix B — open questions

- **Warp**: no public documentation of a dedicated slow-startup stage UX, explicit
  per-message retry buttons, or exact output truncation thresholds (closed source).
- **Zed**: the `agent-client-protocol` Rust crate layout changed; protocol types were
  inferred from Zed's usage rather than read directly. Zed's newer "session config
  options" mechanism (generalizing modes/models) is worth re-checking before
  implementing C2, since adapters may migrate to it.
- **opencode**: exact on-disk storage paths post-SQLite migration unconfirmed; it is an
  ACP *agent* only, so it offers no client-side comparison for fs/terminal handling.
- The `claude-agent-acp` adapter's actual capability advertisement (which
  `promptCapabilities`, whether `session/list`/`load` are declared) was not captured in
  this review — worth one probe run with the Node JSON-RPC script before implementing
  C2/C3.
