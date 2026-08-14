/**
 * Entities layer — the declarative panel view model of ADR-0013.
 *
 * An extension answers `panel/load` / `panel/action` with untrusted JSON;
 * these parsers are the boundary where it becomes typed domain data.
 * Same posture as `parseExtensionActions`: hard caps, unknown fields
 * ignored, malformed entries dropped rather than fatal — a bad view
 * degrades to a smaller view, never to a broken panel.
 */

export interface PanelSelectOption {
  readonly id: string;
  readonly label: string;
}

/** An inline dropdown on an item (a status change, an assignee, …). */
export interface PanelSelect {
  readonly options: readonly PanelSelectOption[];
  readonly selectedId: string;
}

export interface PanelItem {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly badge?: string;
  readonly select?: PanelSelect;
  /** Present → the item carries a checkbox; checked items render
   *  struck through. Toggling comes back as a `toggle` action. */
  readonly checked?: boolean;
  /** True → the item carries a delete button, coming back as a
   *  `remove` action. The extension owns what removal means. */
  readonly removable?: boolean;
}

export interface PanelGroup {
  readonly title: string;
  readonly items: readonly PanelItem[];
}

/** A panel-level button ("Log in", "New issue") — clicking it comes back
 *  as a `button` action carrying the id. */
export interface PanelButton {
  readonly id: string;
  readonly label: string;
}

/** A panel-level text field ("Add a todo…") — the user's Enter comes
 *  back as a `submit` action carrying the id and the typed text. */
export interface PanelInput {
  readonly id: string;
  readonly placeholder?: string;
}

export interface PanelView {
  readonly groups: readonly PanelGroup[];
  readonly buttons: readonly PanelButton[];
  readonly input?: PanelInput;
  /** Shown instead of the list when there are no groups — the
   *  extension's own words ("Add your API key to …"). */
  readonly emptyText?: string;
}

export interface PanelDetailField {
  readonly label: string;
  readonly value: string;
}

/** What the modal shows after an item is opened. */
export interface PanelDetail {
  readonly title: string;
  readonly subtitle?: string;
  readonly fields: readonly PanelDetailField[];
  readonly body?: string;
  /** Opened externally by the host; anything but http(s) is dropped. */
  readonly url?: string;
}

/** A `panel/action` answer: either or both, both optional. */
export interface PanelActionResult {
  readonly view?: PanelView;
  readonly detail?: PanelDetail;
}

const MAX_GROUPS = 20;
const MAX_ITEMS = 100;
const MAX_OPTIONS = 50;
const MAX_FIELDS = 20;
const MAX_BUTTONS = 5;
const MAX_TEXT = 200;
const MAX_SUBTITLE = 400;
const MAX_BODY = 20_000;

export function parsePanelView(payload: unknown): PanelView {
  const view = asObject(payload) ?? {};
  const groups = asArray(view.groups)
    .slice(0, MAX_GROUPS)
    .flatMap((group) => parseGroup(group) ?? []);
  const buttons = asArray(view.buttons)
    .slice(0, MAX_BUTTONS)
    .flatMap((button) => {
      const entry = asObject(button);
      const id = optionalText(entry?.id, MAX_TEXT);
      const label = optionalText(entry?.label, MAX_TEXT);
      return id && label ? [{ id, label }] : [];
    });
  return {
    groups,
    buttons,
    input: parseInput(view.input),
    emptyText: optionalText(view.emptyText, MAX_SUBTITLE),
  };
}

function parseInput(payload: unknown): PanelInput | undefined {
  const input = asObject(payload);
  const id = optionalText(input?.id, MAX_TEXT);
  if (!input || !id) return undefined;
  return { id, placeholder: optionalText(input.placeholder, MAX_TEXT) };
}

export function parsePanelActionResult(payload: unknown): PanelActionResult {
  const result = asObject(payload) ?? {};
  return {
    view: result.view === undefined ? undefined : parsePanelView(result.view),
    detail: parseDetail(result.detail),
  };
}

function parseGroup(payload: unknown): PanelGroup | null {
  const group = asObject(payload);
  const title = optionalText(group?.title, MAX_TEXT);
  if (!group || !title) return null;
  return {
    title,
    items: asArray(group.items)
      .slice(0, MAX_ITEMS)
      .flatMap((item) => parseItem(item) ?? []),
  };
}

function parseItem(payload: unknown): PanelItem | null {
  const item = asObject(payload);
  const id = optionalText(item?.id, MAX_TEXT);
  const title = optionalText(item?.title, MAX_TEXT);
  if (!item || !id || !title) return null;
  return {
    id,
    title,
    subtitle: optionalText(item.subtitle, MAX_SUBTITLE),
    badge: optionalText(item.badge, MAX_TEXT),
    select: parseSelect(item.select),
    checked: typeof item.checked === "boolean" ? item.checked : undefined,
    removable: item.removable === true ? true : undefined,
  };
}

function parseSelect(payload: unknown): PanelSelect | undefined {
  const select = asObject(payload);
  const selectedId = optionalText(select?.selectedId, MAX_TEXT);
  if (!select || !selectedId) return undefined;
  const options = asArray(select.options)
    .slice(0, MAX_OPTIONS)
    .flatMap((option) => {
      const entry = asObject(option);
      const id = optionalText(entry?.id, MAX_TEXT);
      const label = optionalText(entry?.label, MAX_TEXT);
      return id && label ? [{ id, label }] : [];
    });
  return options.length > 0 ? { options, selectedId } : undefined;
}

function parseDetail(payload: unknown): PanelDetail | undefined {
  const detail = asObject(payload);
  const title = optionalText(detail?.title, MAX_TEXT);
  if (!detail || !title) return undefined;
  return {
    title,
    subtitle: optionalText(detail.subtitle, MAX_SUBTITLE),
    fields: asArray(detail.fields)
      .slice(0, MAX_FIELDS)
      .flatMap((field) => {
        const entry = asObject(field);
        const label = optionalText(entry?.label, MAX_TEXT);
        const value = optionalText(entry?.value, MAX_SUBTITLE);
        return label && value ? [{ label, value }] : [];
      }),
    body: optionalText(detail.body, MAX_BODY),
    url: httpUrl(optionalText(detail.url, MAX_SUBTITLE)),
  };
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("https://") || value.startsWith("http://") ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
