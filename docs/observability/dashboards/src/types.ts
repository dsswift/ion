// Query-class taxonomy for the dashboards-as-code generator.
//
// Every LogQL expression in the canonical query module declares one of three
// classes. The class determines what the panel builders will accept, and it is
// the mechanism that makes the timeseries-overcount bug UNWRITABLE:
//
//   accumulation  — sum_over_time / count_over_time. A running total or count.
//                   On a RANGE (timeseries) target the window MUST be
//                   `$__interval` so each step sums only its own bucket and the
//                   series integrates to the true range total. A FIXED window on
//                   a range target is the overcount bug (the $7.26K-against-$255
//                   defect): every step re-sums the whole fixed window. On an
//                   INSTANT target a fixed window is correct and required (the
//                   "spend over the last 24h" single number).
//
//   windowed-stat — quantile_over_time / avg_over_time / max_over_time /
//                   last_over_time, and deliberately-rolling count_over_time.
//                   A fixed rolling window is the POINT of the calculation
//                   (p95 over the last 5m, latest value in the last 10m). Fixed
//                   windows are legitimate on range targets; the builder pins
//                   the window in the panel title so title/window can't drift.
//
//   instant       — ranked / pie / table snapshots evaluated once over a fixed
//                   window (or `$__range`). Always emitted with instant
//                   evaluation; never plotted as a per-step series.
export type QueryClass = 'accumulation' | 'windowed-stat' | 'instant';

// A window token as it appears inside a LogQL range selector `[...]`.
// Either a Grafana macro or a fixed Prometheus-style duration.
export type Window = '$__interval' | '$__range' | FixedWindow;

// Fixed durations used across the packs. Kept as a closed union so a typo in a
// recipe is a compile error rather than a silently-wrong window.
export type FixedWindow =
  | '1m' | '5m' | '10m' | '30m' | '1h' | '24h' | '1d' | '7d' | '30d';

// A fully-built LogQL expression carrying the metadata the panel builders and
// the structural overcount audit need. `window` is the token used inside the
// range selector, or null for log-stream / label / instant-vector expressions
// that carry no `[...]` selector.
export interface Expr {
  readonly expr: string;
  readonly cls: QueryClass;
  readonly window: Window | null;
  // When true, a series panel bearing this target MUST mention the fixed window
  // in its title. Set only on deliberate ROLLING-COUNT windowed-stats (the
  // "(5m)" / "(1m)" panels the plan calls out), where the window is part of the
  // panel's stated meaning and title/window drift is the defect to prevent.
  // Statistical windows (rate/quantile/avg smoothing) leave this false: their
  // titles conventionally omit the window ("p50 / p95", "Log volume by
  // component"), and forcing it in would be noise, not safety.
  readonly pinWindow?: boolean;
}

// True for a concrete duration like `24h` / `5m` / `1d`; false for the Grafana
// macros `$__interval` and `$__range`, which are step- or range-relative and
// therefore never overcount.
export function isFixedWindow(w: Window | null): w is FixedWindow {
  return w !== null && w !== '$__interval' && w !== '$__range';
}

// Loki datasource reference shared by every target and template variable.
export const LOKI = { type: 'loki', uid: 'loki' } as const;
// Tempo datasource reference for the forensics dispatch-tree trace panel.
export const TEMPO = { type: 'tempo', uid: 'tempo' } as const;
