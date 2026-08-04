import { Check, CheckSquare, ClipboardText, Square, X } from "@phosphor-icons/react";
import { useState } from "react";
import type { PlanEntry } from "../../core/entities/plan";
import { planTitle, planToMarkdown } from "../../core/entities/plan";
import { Markdown } from "./MarkdownLite";

/**
 * UI — a slim clickable bar at the top of the chat showing the step the
 * agent is working on right now (structured plan), or the plan-mode
 * plan's title. Hidden while there is no plan of either kind (the plan
 * button in the composer toolbar also opens the plan section).
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
  onClose,
}: {
  plan: readonly PlanEntry[];
  planMarkdown?: string;
  /** Set by the drag handle on the panel's left edge. */
  width: number;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyMarkdown = () => {
    const markdown = plan.length > 0 ? planToMarkdown(plan) : (planMarkdown ?? "");
    void navigator.clipboard.writeText(markdown).then(() => setCopied(true));
  };

  return (
    <aside className="plan-side" style={{ width }} aria-label="Plan">
      <div className="plan-side__header">
        <h3 className="plan-side__heading">
          <ClipboardText /> Plan
        </h3>
        <div className="plan-side__actions">
          <button type="button" className="changes__action" onClick={copyMarkdown}>
            {copied ? (
              <>
                <Check /> Copied
              </>
            ) : (
              "Copy"
            )}
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
        {plan.length > 0 ? (
          <ul className="plan-viewer__list">
            {plan.map((entry, index) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: a PlanEntry has no id and the plan is replaced wholesale, so position is the only identity
                key={index}
                className={`plan-viewer__item plan-viewer__item--${entry.status}`}
              >
                <span className="plan-viewer__checkbox">
                  {entry.status === "completed" ? (
                    <CheckSquare weight="fill" />
                  ) : (
                    <Square />
                  )}
                </span>
                <span className="plan-viewer__content">{entry.content}</span>
                {entry.status === "in_progress" && (
                  <span className="plan-viewer__badge plan-viewer__badge--progress">
                    in progress
                  </span>
                )}
                {entry.priority === "high" && (
                  <span className="plan-viewer__badge plan-viewer__badge--high">
                    high
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : planMarkdown ? (
          <Markdown text={planMarkdown} />
        ) : (
          <p className="plan-viewer__empty">
            No plan yet — the agent publishes one when it breaks a task into steps (plan
            mode, or any multi-step task).
          </p>
        )}
      </div>
    </aside>
  );
}
