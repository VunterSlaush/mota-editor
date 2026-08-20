# ADR-0015 — Quitting is a question, coming back is not

- Status: accepted
- Date: 2026-08-14
- Relates to: ADR-0005 (ACP sessions — `session/resume` is what makes this
  possible), ADR-0003 (Clean Architecture layout — the new port),
  ADR-0001 (lightweight is the product — what a startup may cost)

## Context

Two halves of the same complaint: the app treats leaving and returning as
if nothing was happening.

**Leaving.** An agent turn lives in a subprocess this app owns. There is
no server run to reattach to and no way to pick a killed turn back up
mid-tool-call: closing the window ends every turn instantly and silently.
Closing a *tab* was worse still — `CloseProject` has always cancelled the
turn on its way out, deliberately and without asking.

**Returning.** Startup restored the tab strip and warmed each tab's agent
session, and stopped there. Every tab came back as an empty chat. The
transcript was on disk the whole time (`historySessionId` was persisted
precisely so the conversation would not be cut into one history entry per
launch), and the agent's own session id was persisted next to it — but
nothing read either until the user went to History and opened the top
row by hand. Worse, `resume_session_id` reaches only the *headless*
fallback path; the ACP path ignores it, so even the first message after a
restart went to an agent with no memory of the conversation above it.

## Decision

**One predicate decides both.** `tabIsWorking` (entities/tabStatus) is
true for a running turn or a prompt queued behind one — deliberately
narrower than "not idle". An unanswered approval or a failed turn is a
tab you can walk away from; a running turn is not. `CloseProject`
exposes it as `needsConfirmation(tabId)`, a query beside the command;
`QuitApp` maps it over the whole strip.

**The window's close button becomes ours.** A new `WindowPort`
(`onCloseRequested` / `close`) with a Tauri adapter that takes over the
gesture and answers it with `destroy` — Tauri's `close` re-raises the
very event the listener is answering, so quitting through it would ask
forever. Registered once, latest handler wins, so a view that remounts
does not stack prompts. The alternative — `WindowEvent::CloseRequested`
plus `api.prevent_close()` in Rust, and a command to finally close —
needs two hops and a new command to say the same thing.

**Coming back is two halves, ordered by what they cost.** The transcript
is ours and on disk: `restoreSessions` reads it and paints the tab in a
file read, so the conversation is there on the first frame. Rejoining the
*agent* means booting it and asking it to take the conversation back, so
it runs behind the paint, per tab, and says how it went. `preferResume`
is set because the screen already holds the conversation — the agent may
then attach without replaying it, which is the difference between a
second and a minute; the replay it sends when it cannot is dropped.

**A rejoin that fails still keeps the transcript.** The tab adopts the
session id either way, as opening a local history row always has, so the
conversation goes on appending to the entry it came from instead of
forking a duplicate of itself. Only the note differs, and both notes are
stripped when the transcript is painted back: the transcript is saved
with whatever is on screen, so a launch note left in would earn the
conversation one more of itself every time the app is opened.

Startup cost is unchanged in shape: `warmAllTabs` already booted every
tab's agent at once and is now gone, replaced by one `warmTab` per tab
that has nothing to rejoin. A tab that does pays a `session/resume` on
top of a boot it was paying anyway.

## Consequences

- `core:window:allow-destroy` joins the capability list. It is the only
  new privilege, and it is the one the close button already had.
- The webview now owns whether the app can quit. A frontend wedged badly
  enough to stop rendering is a window that will not close — accepted:
  the same webview already owns every other way out of the app.
- Two tabs of one repository can wear the same label, so the quit
  dialog's list carries tab ids rather than keying on the words.
- Not taken: confirming on an unanswered approval (you can leave one),
  a "close all other tabs" verb, and saving in-flight turns for later —
  the last one is not ours to give, it is the agent CLIs'.
