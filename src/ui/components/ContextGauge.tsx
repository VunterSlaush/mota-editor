const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface Props {
  usage: { readonly used: number; readonly size: number } | undefined;
  /** Fraction at which the app auto-compacts (colors the ring). */
  threshold: number;
}

/**
 * UI — a small circular gauge of the session's context-window usage.
 * Green → amber near the auto-compact threshold → red beyond it.
 */
export function ContextGauge({ usage, threshold }: Props) {
  if (!usage || usage.size === 0) return null;

  const fraction = Math.min(usage.used / usage.size, 1);
  const percent = Math.round(fraction * 100);
  const color =
    fraction >= threshold
      ? "#ff6b6b"
      : fraction >= threshold - 0.15
        ? "#f0b429"
        : "#7ee2a8";

  return (
    <span
      className="context-gauge"
      role="img"
      title={`Context: ${percent}% used (${format(usage.used)} of ${format(usage.size)} tokens). Auto-compacts at ${Math.round(threshold * 100)}%.`}
      aria-label={`Context ${percent} percent used`}
    >
      {/* Decorative: the accessible name lives on the wrapper above. */}
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
    </span>
  );
}

function format(tokens: number): string {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}
