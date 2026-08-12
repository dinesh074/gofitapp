// Small shared formatting helpers.

// Compact "2h ago" / "just now" relative time from a unix-seconds timestamp.
export function timeAgo(sec: number): string {
  const diff = Math.max(0, Date.now() / 1000 - sec);
  if (diff < 60) return "just now";
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1d ago" : `${d}d ago`;
}
