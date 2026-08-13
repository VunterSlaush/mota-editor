import { ArrowSquareOut, ArrowsClockwise } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { ExtensionPanelRef } from "../../core/entities/extension";
import type {
  PanelActionResult,
  PanelDetail,
  PanelView,
} from "../../core/entities/extensionPanels";
import type { PanelActionRequest } from "../../core/ports/extensionHost";
import { openExternalLink } from "../externalLink";
import { Markdown } from "./MarkdownLite";

/**
 * What extension panels need from outside, bundled like `ShellsView` —
 * the panel list for the activity bar plus the load/action/subscribe
 * trio bound to the active tab.
 */
export interface ExtensionPanelsView {
  readonly panels: readonly ExtensionPanelRef[];
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
  const [view, setView] = useState<PanelView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<PanelDetail | null>(null);
  const [pendingItemId, setPendingItemId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    panels
      .load(panel)
      .then((loaded) => {
        if (!cancelled) setView(loaded);
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
  }, [panels, panel, refreshKey]);

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
      if (result.view) setView(result.view);
      if (result.detail) setDetail(result.detail);
    });

  const selectValue = (itemId: string, value: string) =>
    run({ action: "select", itemId, value }, (result) => {
      if (result.view) setView(result.view);
    });

  const pressButton = (buttonId: string) =>
    run({ action: "button", itemId: buttonId }, (result) => {
      if (result.view) setView(result.view);
      if (result.detail) setDetail(result.detail);
    });

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
          <ArrowsClockwise />
        </button>
      </div>
      {error && <p className="changes__notice changes__notice--error">{error}</p>}
      {loading && !view && <p className="changes__empty">Loading…</p>}
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
                <button
                  type="button"
                  className="ext-panel__item-open"
                  disabled={pendingItemId === item.id}
                  onClick={() => openItem(item.id)}
                >
                  <span className="ext-panel__item-main">
                    <span className="ext-panel__item-title">{item.title}</span>
                    {item.badge && <span className="ext-panel__badge">{item.badge}</span>}
                  </span>
                  {item.subtitle && (
                    <span className="ext-panel__item-subtitle">{item.subtitle}</span>
                  )}
                </button>
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
      {detail && <PanelDetailModal detail={detail} onClose={() => setDetail(null)} />}
    </aside>
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
