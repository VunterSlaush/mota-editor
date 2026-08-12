import { useEffect, useRef, useState } from "react";
import { formatTokens } from "../../core/entities/tokens";
import type { TabState } from "../../core/state/appState";

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface Props {
  usage: TabState["usage"];
  /** Fraction at which the app auto-compacts (colors the ring). */
  threshold: number;
}

/**
 * UI — a small circular gauge of the session's context-window usage, and
 * the numbers behind it on click.
 *
 * Green → amber near the auto-compact threshold → red beyond it.
 *
 * Shown only once the window size is known for certain. A fresh Claude
 * session reports the adapter's placeholder until the first turn lands
 * (`usage.provisional`), and a gauge against a made-up denominator is
 * worse than no gauge: the user reads a percentage that quietly changes
 * meaning later.
 */
export function ContextGauge({ usage, threshold }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // A click anywhere else, or Escape, closes the panel — the same
  // vocabulary as the composer's pickers.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!usage || usage.size === 0 || usage.provisional) return null;

  const fraction = Math.min(usage.used / usage.size, 1);
  const percent = Math.round(fraction * 100);
  const color =
    fraction >= threshold
      ? "#ff6b6b"
      : fraction >= threshold - 0.15
        ? "#f0b429"
        : "#7ee2a8";
  const approx = usage.estimated ? "≈ " : "";
  const compactAt = Math.round(usage.size * threshold);
  const untilCompact = Math.max(compactAt - usage.used, 0);

  return (
    <div className="context-gauge" ref={rootRef}>
      <button
        type="button"
        className="context-gauge__trigger"
        title={`${approx}Context: ${percent}% used (${formatTokens(usage.used)} of ${formatTokens(usage.size)} tokens). Auto-compacts at ${Math.round(threshold * 100)}%.`}
        aria-label={`Context ${percent} percent used`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <circle
            cx="10"
            cy="10"
            r={RADIUS}
            fill="none"
            stroke="var(--border)"
            strokeWidth="2.5"
          />
          <circle
            cx="10"
            cy="10"
            r={RADIUS}
            fill="none"
            stroke={color}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
            transform="rotate(-90 10 10)"
          />
        </svg>
      </button>
      {open && (
        <div className="context-gauge__panel">
          <div className="context-gauge__headline">
            <span className="context-gauge__percent" style={{ color }}>
              {approx}
              {percent}%
            </span>
            <span className="context-gauge__caption">of the context window used</span>
          </div>
          <div className="context-gauge__bar">
            <div
              className="context-gauge__fill"
              style={{ width: `${fraction * 100}%`, background: color }}
            />
          </div>
          <dl className="context-gauge__rows">
            <Row label="Used" value={`${approx}${formatTokens(usage.used)}`} />
            <Row
              label="Free"
              value={`${approx}${formatTokens(Math.max(usage.size - usage.used, 0))}`}
            />
            <Row label="Window" value={formatTokens(usage.size)} />
            <Row
              label={`Auto-compacts at ${Math.round(threshold * 100)}%`}
              value={`${formatTokens(untilCompact)} away`}
            />
          </dl>
          {usage.estimated && (
            <p className="context-gauge__note">
              Estimated — this agent reports no usage, so Mota counts the conversation
              itself.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="context-gauge__row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
