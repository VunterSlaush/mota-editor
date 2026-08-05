/**
 * Entities layer — how long something has been running, said the way a
 * person reads a stopwatch. Seconds up to a minute, then m:ss, then
 * h:mm:ss. Never negative: a clock that jumps backwards should read 0s,
 * not "-3s".
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);

  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
