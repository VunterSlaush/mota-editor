# ADR-0021 — Extension panel icons from the extension's own image file

- Status: accepted
- Date: 2026-09-07
- Relates to: ADR-0013 (declarative panels — amends its "icons are named,
  not supplied" consequence), ADR-0012 (extensions over stdio — the trust
  posture this must keep)

## Context

ADR-0013 gave panels an `icon` chosen from a small named set the host maps
to its icon font, so that extensions could not draw arbitrary pixels in
the activity bar. The set has since grown from five names to eight, one
extension at a time, and the first extension with a brand of its own (the
rtk Token Saver) had no honest option: "coins" is a metaphor, and no name
in the set will ever spell what an author wants their icon to say.

Two constraints still hold. No extension code runs in the webview, and
the webview reaches no network and no arbitrary file: its CSP admits
images only from `'self'` and `data:`. Whatever an extension supplies has
to arrive through the host, sized and shaped by the host, and look like it
belongs next to the built-in glyphs in every theme.

## Decision

- **`icon` may be a file path.** A value ending in `.svg`, `.png` or
  `.ico` (any case) is a path relative to the extension folder, forward
  slashes only, no `..`, no drive letter. Anything else is still a name
  from the fixed set. Both forms live in the same string, so a manifest
  written for an older host stays valid and an older host shows the
  generic puzzle piece for a path it does not recognise.
- **The host reads it, once, into the descriptor.** When it lists
  extensions, the Rust host canonicalizes the path, refuses it if it
  resolves outside the folder (symlinks included) or exceeds 128 KB, and
  otherwise base64-encodes the bytes into a `data:` URL carried on the
  panel descriptor (`iconData`). The webview never touches the file, no
  asset protocol or scope is opened, and the CSP is unchanged. A missing
  or oversized file keeps the panel with the generic icon and puts the
  reason in the descriptor's `error`, where Settings already shows it.
- **Drawn as a masked silhouette, never as an image.** The activity bar
  uses the data URL as a CSS `mask-image` on a `currentColor` box. The
  extension supplies a shape; the host supplies the colour, so the icon
  dims, lights on hover and takes the accent when active exactly like its
  neighbours, in every theme. This is the same trade VS Code makes, and it
  keeps ADR-0013's promise in substance: an extension still cannot put
  arbitrary pixels — colours, photos, text in its own palette — in the
  bar.
- **Layering follows ADR-0012.** Telling a path from a name and rejecting
  an escaping path is pure logic in `agent_core::extension`
  (`panel_icon_file`, tested); reading and capping the file sits beside
  the prompt-file reader in `extension_discovery`; the data URL is built
  in `extension_host` with the `base64` crate the app already has; the
  frontend carries `iconData` through the port, entity and adapters
  untouched by any parsing, and only the activity bar knows it is a mask.

## Consequences

- No new dependency, permission, command or event. `ui:panel` still
  gates the whole feature.
- Descriptors grow by the icon's size on every extension refresh; the
  128 KB cap bounds that, and a 20 px icon has no business being larger.
- Authors must design for monochrome: a coloured logo becomes its outline.
  `docs/EXTENSIONS.md` says so and says how to design for it.
- `.ico` decodes wherever the webview does (WebView2, WebKit); a file the
  webview cannot decode renders as an empty mask, i.e. nothing. The store
  validator checks the file exists and has an allowed extension, not that
  it decodes — that remains the author's test in Mota itself.

## Alternatives considered

- **Keep growing the named set** — every new extension with an identity
  would need a host release, and the set would still never contain a
  brand.
- **Serve the file through Tauri's asset protocol** — needs a scope that
  admits every extension folder and a CSP change; more surface for a
  20 px image than reading the bytes once.
- **Render the image as-is (`<img>`)** — keeps colour, loses the bar's
  states and theme consistency, and hands extensions the arbitrary pixels
  ADR-0013 refused. Rejected; if a coloured mode is ever wanted it is an
  explicit opt-in in a later ADR, not the default.
- **Inline SVG in the manifest** — would need a sanitizer for markup
  handed to the DOM; a masked raster of a file the webview never parses
  as markup is smaller and safer.
