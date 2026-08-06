import {
  ArrowsOutSimple,
  Check,
  CheckSquare,
  ClipboardText,
  Square,
  X,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { PlanEntry } from "../../core/entities/plan";
import { planTitle, planToMarkdown } from "../../core/entities/plan";
import { Markdown } from "./MarkdownLite";

/**
 * UI — a slim clickable bar at the top of the chat showing the step the
 * agent is working on right now (structured plan), or the plan-mode
 * plan's title. Hidden while there is no plan of either kind.
 */
export function PlanBar({
  plan,
  planMarkdown,
  onOpen,
}: {
  plan: readonly PlanEntry[];
  planMarkdown?: string;
  onOpen: () => void;
}) {
  if (plan.length === 0 && !planMarkdown) return null;
  const done = plan.filter((e) => e.status === "completed").length;
  const title = plan.length > 0 ? planTitle(plan) : markdownTitle(planMarkdown ?? "");

  return (
    <button
      type="button"
      className="plan-bar"
      onClick={onOpen}
      title="View the full plan"
    >
      <ClipboardText className="plan-bar__icon" />
      <span className="plan-bar__title">{title}</span>
      {plan.length > 0 && (
        <span className="plan-bar__progress">
          {done}/{plan.length}
        </span>
      )}
    </button>
  );
}

/** First heading (or first line) of a markdown plan. */
function markdownTitle(markdown: string): string {
  const first = markdown
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return first?.replace(/^#{1,4}\s*/, "") ?? "Plan";
}

/**
 * UI — the plan as a right-side section of the chat: the structured
 * checklist when the agent tracks steps, otherwise the plan-mode
 * markdown, properly rendered. Copyable as Markdown either way.
 */
export function PlanSidePanel({
  plan,
  planMarkdown,
  width,
  onExpand,
  onClose,
}: {
  plan: readonly PlanEntry[];
  planMarkdown?: string;
  /** Set by the drag handle on the panel's left edge. */
  width: number;
  onExpand: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="plan-side" style={{ width }} aria-label="Plan">
      <div className="plan-side__header">
        <h3 className="plan-side__heading">
          <ClipboardText /> Plan
        </h3>
        <div className="plan-side__actions">
          <CopyPlanButton plan={plan} planMarkdown={planMarkdown} />
          <button
            type="button"
            className="icon-button"
            aria-label="Open plan in a window"
            title="Open plan in a window"
            onClick={onExpand}
          >
            <ArrowsOutSimple />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close plan"
            onClick={onClose}
          >
            <X />
          </button>
        </div>
      </div>
      <div className="plan-side__body">
        <PlanBody plan={plan} planMarkdown={planMarkdown} />
      </div>
    </aside>
  );
}

/** A resized modal never goes below this; the CSS caps handle the top end. */
const MIN_WIDTH_PX = 360;
const MIN_HEIGHT_PX = 240;

/**
 * UI — the plan in a centred modal, for reading a long plan without
 * squeezing the chat. Drag the bottom-right grip to resize; Escape or a
 * click outside closes it.
 */
export function PlanModal({
  plan,
  planMarkdown,
  onClose,
}: {
  plan: readonly PlanEntry[];
  planMarkdown?: string;
  onClose: () => void;
}) {
  // A size the user dragged the modal to; null means the default layout.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Drag the bottom-right grip. The modal is centred both ways, so each
  // pixel of width and height is split between opposite edges — the ×2
  // keeps the grabbed corner under the cursor. Double-click resets.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = modalRef.current;
    if (!el) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const { width, height } = el.getBoundingClientRect();

    const onMove = (move: PointerEvent) => {
      setSize({
        width: Math.max(MIN_WIDTH_PX, width + (move.clientX - startX) * 2),
        height: Math.max(MIN_HEIGHT_PX, height + (move.clientY - startY) * 2),
      });
    };
    const stopDrag = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stopDrag);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stopDrag);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay modal-overlay--center" onMouseDown={onClose}>
      <div
        ref={modalRef}
        className="plan-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Plan"
        style={size ?? undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="plan-side__header">
          <h3 className="plan-side__heading">
            <ClipboardText /> Plan
          </h3>
          <div className="plan-side__actions">
            <CopyPlanButton plan={plan} planMarkdown={planMarkdown} />
            <button
              type="button"
              className="icon-button"
              aria-label="Close plan"
              onClick={onClose}
            >
              <X />
            </button>
          </div>
        </div>
        <div className="plan-side__body">
          <PlanBody plan={plan} planMarkdown={planMarkdown} />
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only affordance; the modal is fully usable at its default size */}
        <div
          className="plan-modal__resize"
          title="Drag to resize · double-click to reset"
          onPointerDown={startResize}
          onDoubleClick={() => setSize(null)}
        />
      </div>
    </div>
  );
}

/** Copies the plan as Markdown, whichever form it is in. */
function CopyPlanButton({
  plan,
  planMarkdown,
}: {
  plan: readonly PlanEntry[];
  planMarkdown?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copyMarkdown = () => {
    const markdown = plan.length > 0 ? planToMarkdown(plan) : (planMarkdown ?? "");
    void navigator.clipboard.writeText(markdown).then(() => setCopied(true));
  };

  return (
    <button type="button" className="changes__action" onClick={copyMarkdown}>
      {copied ? (
        <>
          <Check /> Copied
        </>
      ) : (
        "Copy"
      )}
    </button>
  );
}

/** The structured checklist when the agent tracks steps, otherwise the
 *  plan-mode markdown; shared by the side panel and the modal. */
function PlanBody({
  plan,
  planMarkdown,
}: {
  plan: readonly PlanEntry[];
  planMarkdown?: string;
}) {
  if (plan.length > 0) {
    return (
      <ul className="plan-viewer__list">
        {plan.map((entry, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: a PlanEntry has no id and the plan is replaced wholesale, so position is the only identity
            key={index}
            className={`plan-viewer__item plan-viewer__item--${entry.status}`}
          >
            <span className="plan-viewer__checkbox">
              {entry.status === "completed" ? <CheckSquare weight="fill" /> : <Square />}
            </span>
            <span className="plan-viewer__content">{entry.content}</span>
            {entry.status === "in_progress" && (
              <span className="plan-viewer__badge plan-viewer__badge--progress">
                in progress
              </span>
            )}
            {entry.priority === "high" && (
              <span className="plan-viewer__badge plan-viewer__badge--high">high</span>
            )}
          </li>
        ))}
      </ul>
    );
  }
  if (planMarkdown) return <Markdown text={planMarkdown} />;
  return (
    <p className="plan-viewer__empty">
      No plan yet — the agent publishes one when it breaks a task into steps (plan mode,
      or any multi-step task).
    </p>
  );
}
