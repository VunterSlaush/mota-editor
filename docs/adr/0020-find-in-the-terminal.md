# ADR-0020 — Find in the terminal, on the xterm search addon

- Status: accepted
- Date: 2026-09-02
- Relates to: ADR-0009 (a real pty for the terminal), ADR-0001 (lightweight is
  the product)

## Context

The terminal keeps 5 000 lines of scrollback and no way to look through them.
The line you want is almost always one that has already gone past — the first
compiler error in a long build, the port a dev server said it was on — and the
only way to it was the scrollbar and your eyes.

Search over a terminal buffer is not the string search it looks like. xterm
wraps long output across rows, so a match can straddle a wrap boundary and a
naive per-row scan misses exactly the long lines people are searching for.
Getting that right, plus highlight-all, a match count, and scroll-into-view, is
a few hundred lines of fiddly work against xterm's buffer API.

`@xterm/addon-search` is that work, done by the people who wrote the buffer it
reads. It is the official companion to the `@xterm/xterm` this app already
ships, from the same repository, and it is the second addon here — `addon-fit`
was the first, for the same reason.

## Decision

- **Take the addon.** `@xterm/addon-search@0.16.0`, ~15 KB, no transitive
  dependencies and no peer requirements beyond the xterm already present. It
  brings wrapped-line handling, decorations for every match, an overview ruler
  down the scrollbar, and the match count the bar shows. Writing this by hand
  to a lower standard, to keep a count at two addons instead of three, is the
  wrong trade — this is the case the "lightweight" rule exists to allow, not
  to forbid.
- **Ctrl+F, and it is taken from the shell.** `terminalSearchIntent` in
  `entities/terminalSearch.ts` decides, next to the `terminalClipboard` entity
  that resolves the same kind of conflict for Ctrl+C. Ctrl+F is readline's
  forward-char and `less`'s page-forward, and binding it costs those. Every
  terminal with a find bar has paid it — VS Code, iTerm, Windows Terminal —
  because the need is more common and the alternatives (Right arrow, Space,
  Ctrl+D) all survive. Ctrl+Shift+F is accepted too, for the habit Windows
  Terminal builds.
- **macOS pays nothing.** Cmd+F there, and Ctrl+F stays the shell's, exactly
  as ADR-era `terminalClipboard` already decided for Ctrl+C. The rule is one
  rule, stated once, applied twice.
- **The bar is laid over the terminal, not stacked above it.** A row of chrome
  above the pty would shrink it by one row, and every full-screen program in it
  would redraw the moment someone pressed Ctrl+F. The host element is xterm's
  own — the panel calls `replaceChildren` on it — so the bar is a sibling in a
  new positioned stage rather than a child.
- **The search is view state, per terminal, and dies with it.** Switching
  terminals closes the bar and clears the highlights behind it. A buffer still
  marked up for a query no longer on screen is a puzzle, not a feature.

## Consequences

- Ctrl+F no longer reaches the shell on Windows and Linux. In `less` and `vim`
  — where it means page-forward, not the redundant forward-char readline gives
  it — that is a real loss, mitigated only by Space and Ctrl+D doing the same
  job. If it grates, the escape hatch is a setting, and a setting is a bigger
  decision than this one.
- A third xterm addon is a third thing to keep in step on an xterm upgrade.
  They version together and ship from one repository, which is most of why
  this one was acceptable.
- Decoration colours are read from the theme per search, so a theme change
  applies to the next search rather than repainting the current one. Not worth
  a subscription: the bar is open for seconds at a time.
- The addon parses its own colours and understands `#RRGGBB` alone, so
  `themeColor` falls back rather than passing on the `#RRGGBBAA` and `rgb()`
  forms the palette is free to use elsewhere.

## Alternatives considered

- **Hand-rolled search over `term.buffer.active`.** Considered seriously and
  costed: pure matching in core, `term.select` and `scrollToLine` in the
  driver. It gets next/prev and a count, but wrapped-line reconstruction is
  the part that decides whether it is correct, and highlight-all needs one
  decoration per match with the perf care that implies. A worse version of a
  maintained thing.
- **Ctrl+Shift+F only**, leaving Ctrl+F to the shell. Safer and less
  discoverable; the shortcut people actually press is Ctrl+F. Both are bound,
  so this is available to anyone who wants it.
- **Search across all terminals at once.** A different feature, and one nobody
  has asked for. The panel already scopes everything else per terminal.
