export type Phase =
  { kind: "loading" } | { kind: "ready" } | { kind: "error"; message: string };

export interface Tooltip {
  x: number;
  y: number;
  title: string;
  lines: string[];
}

/** Humanize seconds: 42s, 3m 12s, 1h 4m. */
export function humanDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "";
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}
