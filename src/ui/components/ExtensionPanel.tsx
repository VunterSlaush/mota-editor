import { ArrowSquareOut, ArrowsClockwise, Trash, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ExtensionPanelRef } from "../../core/entities/extension";
import type {
  PanelActionResult,
  PanelDetail,
  PanelMenuItem,
  PanelView,
} from "../../core/entities/extensionPanels";
import type { PanelActionRequest } from "../../core/ports/extensionHost";
import { openExternalLink } from "../externalLink";
import { Markdown } from "./MarkdownLite";
import { type HostRect, tooltipPlacement } from "./tooltipPlacement";

/**
 * What extension panels need from outside, bundled like `ShellsView` —
 * the panel list for the activity bar plus the load/action/subscribe
 * trio bound to the active tab.
 */
export interface ExtensionPanelsView {
  readonly panels: readonly ExtensionPanelRef[];
  /** The last view this panel produced for the active project, kept
   *  outside the remounting subtree — null the first time it is opened. */
  readonly cached: (panel: ExtensionPanelRef) => PanelView | null;
  readonly remember: (panel: ExtensionPanelRef, view: PanelView) => void;
  readonly load: (panel: ExtensionPanelRef) => Promise<PanelView>;
  readonly action: (
    panel: ExtensionPanelRef,
    request: PanelActionRequest,
  ) => Promise<PanelActionResult>;
  /** Re-pull signal (`panels/refresh`); returns the unsubscribe. */
  readonly subscribe: (panel: ExtensionPanelRef, onChanged: () => void) => () => void;
}

interface Props {
  panel: ExtensionPanelRef;
  panels: ExtensionPanelsView;
}

/**
 * UI — one extension's sidebar panel (ADR-0013): grouped items rendered
 * from the declarative view model, a per-item select routed back as an
 * action, and a detail modal for an opened item. The view arrives
 * already validated; this component only draws it.
 */
export function ExtensionPanel({ panel, panels }: Props) {
  const remembered = panels.cached(panel);
  const [view, setView] = useState<PanelView | null>(remembered);
  const [loading, setLoading] = useState(remembered === null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<PanelDetail | null>(null);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [draft, setDraft] = useState("");
  // A remembered view is already on screen, so the mount that follows a
  // tab switch must NOT pull again — only an explicit refresh or the
  // extension's own push does. Cleared after that first skipped run.
  const servedFromCache = useRef(remembered !== null);

  /** Every view that reaches the screen is also the one a later mount
   *  should start from — including the ones actions hand back. */
  const showView = useCallback(
    (next: PanelView) => {
      setView(next);
      panels.remember(panel, next);
    },
    [panels, panel],
  );

  useEffect(() => {
    if (servedFromCache.current) {
      servedFromCache.current = false;
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    panels
      .load(panel)
      .then((loaded) => {
        if (!cancelled) showView(loaded);
      })
      .catch((e) => {
        if (!cancelled) setError(messageOf(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [panels, panel, refreshKey, showView]);

  // The extension's own "something changed" push becomes a re-pull.
  useEffect(
    () => panels.subscribe(panel, () => setRefreshKey((key) => key + 1)),
    [panels, panel],
  );

  const run = (
    request: PanelActionRequest,
    apply: (result: PanelActionResult) => void,
  ) => {
    setPendingItemId(request.itemId);
    setError(null);
    panels
      .action(panel, request)
      .then(apply)
      .catch((e) => setError(messageOf(e)))
      .finally(() => setPendingItemId(null));
  };

  const openItem = (itemId: string) =>
    run({ action: "open", itemId }, (result) => {
      if (result.view) showView(result.view);
      if (result.detail) setDetail(result.detail);
    });

  const selectValue = (itemId: string, value: string) =>
    run({ action: "select", itemId, value }, (result) => {
      if (result.view) showView(result.view);
    });

  const toggleItem = (itemId: string, checked: boolean) =>
    run({ action: "toggle", itemId, value: checked ? "true" : "false" }, (result) => {
      if (result.view) showView(result.view);
    });

  const removeItem = (itemId: string) =>
    run({ action: "remove", itemId }, (result) => {
      if (result.view) showView(result.view);
    });

  const chooseMenuEntry = (itemId: string, entryId: string) => {
    setMenu(null);
    run({ action: "menu", itemId, value: entryId }, (result) => {
      if (result.view) showView(result.view);
      if (result.detail) setDetail(result.detail);
    });
  };

  const pressButton = (buttonId: string) =>
    run({ action: "button", itemId: buttonId }, (result) => {
      if (result.view) showView(result.view);
      if (result.detail) setDetail(result.detail);
    });

  const submitInput = (inputId: string) => {
    const value = draft.trim();
    if (!value) return;
    run({ action: "submit", itemId: inputId, value }, (result) => {
      setDraft("");
      if (result.view) showView(result.view);
    });
  };

  const input = view?.input;

  return (
    <aside className="ext-panel">
      <div className="ext-panel__toolbar">
        <span className="ext-panel__title">{panel.title}</span>
        <button
          type="button"
          className="changes__action changes__action--icon"
          disabled={loading}
          aria-label="Refresh panel"
          title="Ask the extension again"
          onClick={() => setRefreshKey((key) => key + 1)}
        >
          {/* The button greys out while it works, which says "not now"
              but not "something is happening" — the turning icon does. */}
          <ArrowsClockwise className={loading ? "ext-panel__spin" : undefined} />
        </button>
      </div>
      {error && <p className="changes__notice changes__notice--error">{error}</p>}
      {loading && !view && <p className="changes__empty">Loading…</p>}
      {!loading && input && (
        <form
          className="ext-panel__input"
          onSubmit={(e) => {
            e.preventDefault();
            submitInput(input.id);
          }}
        >
          <input
            className="ext-panel__input-field"
            value={draft}
            placeholder={input.placeholder}
            aria-label={input.placeholder ?? "Panel input"}
            disabled={pendingItemId === input.id}
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
      )}
      {!loading && view && view.groups.length === 0 && (
        <p className="changes__empty">{view.emptyText ?? "Nothing to show."}</p>
      )}
      {!loading && view && view.buttons.length > 0 && (
        <div className="ext-panel__buttons">
          {view.buttons.map((button) => (
            <button
              type="button"
              key={button.id}
              className="changes__action"
              disabled={pendingItemId === button.id}
              onClick={() => pressButton(button.id)}
            >
              {button.label}
            </button>
          ))}
        </div>
      )}
      {view?.groups.map((group) => (
        <section key={group.title} className="ext-panel__group">
          <h3 className="ext-panel__group-title">
            {group.title}
            <span className="ext-panel__count">{group.items.length}</span>
          </h3>
          <ul className="ext-panel__list">
            {group.items.map((item) => (
              <li key={item.id} className="ext-panel__item">
                <div className="ext-panel__item-row">
                  {item.checked !== undefined && (
                    <input
                      type="checkbox"
                      className="ext-panel__check"
                      checked={item.checked}
                      disabled={pendingItemId === item.id}
                      aria-label={`Toggle ${item.title}`}
                      onChange={(e) => toggleItem(item.id, e.target.checked)}
                    />
                  )}
                  <button
                    type="button"
                    className="ext-panel__item-open"
                    disabled={pendingItemId === item.id}
                    title={item.title}
                    onClick={() => openItem(item.id)}
                    onContextMenu={(e) => {
                      // Always swallow the browser menu: a panel item is
                      // an app control, not a document. With no entries
                      // declared, that is all right-click does.
                      e.preventDefault();
                      if (!item.menu) return;
                      setMenu({
                        itemId: item.id,
                        entries: item.menu,
                        anchor: e.currentTarget.getBoundingClientRect(),
                      });
                    }}
                  >
                    <span className="ext-panel__item-main">
                      <span
                        className={`ext-panel__item-title ${
                          item.checked ? "ext-panel__item-title--checked" : ""
                        }`}
                      >
                        {item.title}
                      </span>
                      {item.badge && (
                        <span
                          className={`ext-panel__badge ${
                            item.badgeTone ? `ext-panel__badge--${item.badgeTone}` : ""
                          }`}
                        >
                          {item.badge}
                        </span>
                      )}
                    </span>
                    {item.subtitle && (
                      <span className="ext-panel__item-subtitle">{item.subtitle}</span>
                    )}
                  </button>
                  {item.removable && (
                    <button
                      type="button"
                      className="ext-panel__remove"
                      disabled={pendingItemId === item.id}
                      aria-label={`Delete ${item.title}`}
                      title="Delete"
                      onClick={() => removeItem(item.id)}
                    >
                      <Trash />
                    </button>
                  )}
                </div>
                {item.select && (
                  <select
                    className="ext-panel__select"
                    value={item.select.selectedId}
                    disabled={pendingItemId === item.id}
                    aria-label={`Change ${item.title}`}
                    onChange={(e) => selectValue(item.id, e.target.value)}
                  >
                    {item.select.options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {menu && (
        <PanelItemMenu
          anchor={menu.anchor}
          entries={menu.entries}
          onChoose={(entryId) => chooseMenuEntry(menu.itemId, entryId)}
          onClose={() => setMenu(null)}
        />
      )}
      {detail && <PanelDetailModal detail={detail} onClose={() => setDetail(null)} />}
    </aside>
  );
}

/** The right-click menu of one item, while it is open. */
interface OpenMenu {
  readonly itemId: string;
  readonly entries: readonly PanelMenuItem[];
  readonly anchor: HostRect;
}

/**
 * UI — an item's right-click menu, placed and dismissed like `TabMenu`:
 * measured after it is drawn, closed by Escape or a click elsewhere. The
 * entries are the extension's; this only draws and reports them.
 */
function PanelItemMenu({
  anchor,
  entries,
  onChoose,
  onClose,
}: {
  anchor: HostRect;
  entries: readonly PanelMenuItem[];
  onChoose: (entryId: string) => void;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const { left, top } = tooltipPlacement(
      anchor,
      { width: element.offsetWidth, height: element.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.visibility = "visible";
  }, [anchor]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="ext-menu" ref={panel} role="menu" aria-label="Item actions">
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="menuitem"
          className="ext-menu__entry"
          onClick={() => onChoose(entry.id)}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

function PanelDetailModal({
  detail,
  onClose,
}: {
  detail: PanelDetail;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="ext-detail"
        role="dialog"
        aria-label={detail.title}
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="ext-detail__header">
          <div>
            <h2 className="ext-detail__title">{detail.title}</h2>
            {detail.subtitle && <p className="ext-detail__subtitle">{detail.subtitle}</p>}
          </div>
          <div className="ext-detail__actions">
            {detail.url && (
              <button
                type="button"
                className="changes__action changes__action--icon"
                aria-label="Open in browser"
                title={detail.url}
                onClick={() => detail.url && openExternalLink(detail.url)}
              >
                <ArrowSquareOut />
              </button>
            )}
            <button
              type="button"
              className="changes__action changes__action--icon"
              aria-label="Close"
              title="Close (Esc)"
              onClick={onClose}
            >
              <X />
            </button>
          </div>
        </div>
        {detail.fields.length > 0 && (
          <dl className="ext-detail__fields">
            {detail.fields.map((field) => (
              <div key={field.label} className="ext-detail__field">
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {detail.body && (
          <div className="ext-detail__body">
            <Markdown text={detail.body} />
          </div>
        )}
      </div>
    </div>
  );
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
