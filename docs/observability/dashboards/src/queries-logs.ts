// Canonical log-volume, error, and rolling-count expressions.
//
// This domain covers the engine-log packs (overview, errors-health, live-logs,
// control-room) plus the forensics/quality/trust count aggregations. The class
// distinction that matters here:
//
//   * Range accumulations (log volume over time) use $__interval — enforced.
//   * Headline stats ("Errors", "Log lines") are instant accumulations over
//     $__range so they honor the dashboard time picker (ADR-022).
//   * Fixed windows survive only on detector-class panels: lamps, the ingest
//     freshness detector, last_over_time latest-value panels, and "now"
//     detectors whose window is part of the panel's stated meaning.

import type { Expr, Window } from './types.ts';
import { accumulation, instant, windowedStat, telemetry, registerQuery } from './queries.ts';

// ---------------------------------------------------------------------------
// Level-based counts (engine logs)
// ---------------------------------------------------------------------------

// Instant count of log lines at a level over a window (headline stat; pass
// $__range so the stat follows the dashboard time picker).
export const levelCount = (level: string, window: Window, componentGuard = false): Expr => {
  const sel = componentGuard ? `{component=~".+", level="${level}"}` : `{level="${level}"}`;
  return accumulation(`sum(count_over_time(${sel}[${window}]))`, window);
};

// Instant count of ALL log lines over a window.
export const allLinesCount = (window: Window): Expr =>
  accumulation(`sum(count_over_time({component=~".+"}[${window}]))`, window);

// Instant error rate = errors / all lines over a window.
export const errorRate = (window: Window): Expr =>
  accumulation(
    `sum(count_over_time({level="ERROR"}[${window}])) / sum(count_over_time({component=~".+"}[${window}]))`,
    window,
  );

// Per-level count series, per interval. Replaces the old rolling "(5m)"
// variant: a fixed rolling window undersamples at wide ranges (the query step
// exceeds the window, so most entries fall between samples); a per-interval
// accumulation integrates to the headline total at any range.
export const levelSeriesInterval = (level: string): Expr =>
  accumulation(`sum(count_over_time({level="${level}"}[$__interval]))`, '$__interval');

// Error count grouped by component, per interval (same undersampling fix).
export const errorsByComponentInterval = (): Expr =>
  accumulation(`sum by (component) (count_over_time({level="ERROR"}[$__interval]))`, '$__interval');

// Top error sources by component+tag, INSTANT over a window. This is the
// overcount fix: it was a [24h] range timeseries; a ranked snapshot is instant.
export const topErrorSources = (window: Window): Expr =>
  accumulation(`sum by (component, tag) (count_over_time({level="ERROR"}[${window}]))`, window);

// ---------------------------------------------------------------------------
// Log volume by component / extension
// ---------------------------------------------------------------------------

// Log volume by component, per interval (overview accumulation series).
export const logVolumeByComponentInterval = (): Expr =>
  accumulation(`sum by (component) (count_over_time({component=~".+"}[$__interval]))`, '$__interval');

// Overview uses rate() (per-second) by component for its headline volume chart.
export const logRateByComponent = (window: Window): Expr =>
  windowedStat(`sum by (component) (rate({component=~".+"}[${window}]))`, window);

// Extension log volume per interval (the [1h]->$__interval overcount fix).
export const extensionVolumeInterval = (): Expr =>
  accumulation(`sum by (tag) (count_over_time({component="extension"}[$__interval]))`, '$__interval');

// Active-extension count over a window (headline stat, nested count).
export const activeExtensionCount = (window: Window): Expr =>
  accumulation(`count(count by (tag) (count_over_time({component="extension"}[${window}])))`, window);

// ---------------------------------------------------------------------------
// Ingest freshness (per-component minutes since last log line)
// ---------------------------------------------------------------------------

// Minutes since the most recent log line for each component. This is the
// tailer-wedge detector: when Alloy's cursor for one file freezes (e.g. the
// Docker Desktop virtiofs bind-mount serves a stale, size-frozen view of a file
// the engine is still appending to on the host — see README "Tailer wedge"),
// that component's freshness climbs while the others stay near zero, turning its
// tile red within minutes.
//
// Shape, proven against Loki 3.7.3:
//   * max_over_time(... | label_format ts_unix="{{ __timestamp__ | unixEpoch }}"
//     | unwrap ts_unix [24h]) — the newest entry's event-time (Unix seconds) per
//     component. label_format promotes the log line's own timestamp into an
//     unwrappable numeric field (Loki has no bare timestamp() function).
//   * vector(${__to:date:seconds}) — the dashboard range-end as a bare Unix-
//     seconds literal. Loki's vector() accepts only a literal number (no
//     arithmetic, no time()); Grafana expands the date-format macro client-side
//     before the query reaches Loki.
//   * `- on() group_right()` — vector() carries no labels; group_right keeps the
//     per-component labels from the right operand so the subtraction is a valid
//     one-to-many match (a bare subtraction drops every series on label mismatch).
//   * `/ 60` — seconds to minutes.
//   * [24h] lookback (NOT $__range): a wide fixed net so a component that wedged
//     an hour ago stays VISIBLE as a growing red value instead of dropping out
//     of a narrow range window — the whole point of a freshness detector.
//
// Class `instant`: a per-component snapshot evaluated once over a fixed window,
// never plotted per step. It carries no accumulation, so the overcount guard
// does not apply; the [24h] selector is legitimate on the instant stat panel.
export const ingestFreshnessMinutes = (window: Window): Expr =>
  registerQuery(
    'Ingest freshness by component (minutes since last line)',
    'Minutes since the most recent log line per component. The tailer-wedge detector: ' +
      'a frozen Alloy cursor makes one component climb while the others stay near zero. ' +
      'Thresholded green <5m / orange <30m / red beyond on the overview. vector() uses the ' +
      'Grafana ${__to:date:seconds} macro (Loki vector() needs a bare literal); group_right ' +
      'keeps the per-component labels; the [24h] lookback keeps a wedged component visible ' +
      'as a growing red value rather than dropping it from a narrow window.',
    instant(
      `(vector(\${__to:date:seconds}) - on() group_right() ` +
        `max by (component) (max_over_time({component=~".+"} ` +
        `| label_format ts_unix="{{ __timestamp__ | unixEpoch }}" | unwrap ts_unix [${window}]))) / 60`,
      window,
    ),
  );

// ---------------------------------------------------------------------------
// Control-room lamps (instant activity counts over a fixed window)
// ---------------------------------------------------------------------------

// Instant count of lines for a component (optionally an extension tag) lamp.
export const componentLamp = (component: string, window: Window, tag?: string): Expr => {
  const sel = tag ? `{component="${component}", tag="${tag}"}` : `{component="${component}"}`;
  return accumulation(`sum(count_over_time(${sel}[${window}]))`, window);
};

// Instant count of telemetry tool.execute events for one tool (lamp).
export const toolLamp = (tool: string, window: Window): Expr =>
  accumulation(`sum(count_over_time(${telemetry('tool.execute')} | tool="${tool}" [${window}]))`, window);

// Instant count of telemetry events of a kind (lamp / "in flight" stat).
export const kindCount = (kind: string, window: Window, useJson = false): Expr => {
  const sel = useJson ? `${telemetry(kind)} | json` : telemetry(kind);
  return accumulation(`sum(count_over_time(${sel} [${window}]))`, window);
};

// ---------------------------------------------------------------------------
// Generic telemetry accumulations grouped by a payload label
// ---------------------------------------------------------------------------

// Instant grouped count of a telemetry kind over a fixed window (pie/table).
export const groupedKindCount = (kind: string, by: readonly string[], window: Window): Expr =>
  instant(`sum by (${by.join(', ')}) (count_over_time(${telemetry(kind)} | json [${window}]))`, window);

// Per-interval grouped count of a telemetry kind (timeseries accumulation).
export const groupedKindSeries = (kind: string, by: readonly string[]): Expr =>
  accumulation(
    `sum by (${by.join(', ')}) (count_over_time(${telemetry(kind)} | json [$__interval]))`,
    '$__interval',
  );

// Per-interval grouped sum of an unwrapped payload field (timeseries).
export const groupedUnwrapSeries = (kind: string, field: string, by: readonly string[]): Expr =>
  accumulation(
    `sum by (${by.join(', ')}) (sum_over_time(${telemetry(kind)} | json | unwrap ${field} [$__interval]))`,
    '$__interval',
  );

// Per-interval total sum of an unwrapped payload field (timeseries).
export const totalUnwrapSeries = (kind: string, field: string): Expr =>
  accumulation(`sum(sum_over_time(${telemetry(kind)} | json | unwrap ${field} [$__interval]))`, '$__interval');
