// Canonical latency / windowed-statistic expressions.
//
// This domain covers the legitimate windowed statistics: quantile_over_time,
// avg_over_time, max_over_time, last_over_time. A fixed rolling window is the
// POINT of these calculations (p95 over the last 5m, latest value in the last
// 10m), so they are class `windowed-stat`. On a series panel the builder pins
// the window into the title; on an instant panel they evaluate once.
//
// wire-latency, quality (hook/tool latency), intelligence (provider league),
// errors-health (TTFT/gap), live-logs (context pressure), and forensics (turn
// latency) all draw from here.

import type { Expr, Window } from './types.ts';
import { windowedStat, instant, telemetry } from './queries.ts';

// Quantile of an unwrapped telemetry payload field, optionally grouped, over a
// window. windowed-stat: legitimate on range or instant targets.
//
// CARDINALITY GUARD: `quantile_over_time(...)` WITHOUT an aggregation clause
// preserves one output series per distinct label set on the parsed stream.
// After `| json`, every telemetry payload field (conversation_id, session_id,
// request_id, model, ...) becomes a label, so an ungrouped quantile fans out
// into one series per conversation — hundreds of series — and Loki rejects the
// query with "maximum number of series (500) reached". A p50/p99 line is a
// SINGLE aggregate statistic, so when no explicit `by` is requested we bind an
// empty `by ()` to collapse the fan-out to one series. An explicit `by` still
// takes exactly the low-cardinality grouping the caller asked for (e.g. by
// model, by tool). `by ()` is always emitted so the aggregation is unambiguous
// on every Loki version, never left implicit.
export function quantile(opts: {
  q: number;
  kind: string;
  field: string;
  window: Window;
  by?: readonly string[];
  filter?: string;
}): Expr {
  const filter = opts.filter ?? '';
  const by = opts.by && opts.by.length ? ` by (${opts.by.join(', ')})` : ' by ()';
  const expr =
    `quantile_over_time(${opts.q}, ${telemetry(opts.kind)} | json${filter}` +
    ` | unwrap ${opts.field} [${opts.window}])${by}`;
  return windowedStat(expr, opts.window);
}

// Average of an unwrapped payload field over a window (windowed-stat).
export function avg(opts: {
  kind?: string;
  selector?: string;
  field: string;
  window: Window;
  filter?: string;
}): Expr {
  const sel = opts.selector ?? telemetry(opts.kind ?? '');
  const filter = opts.filter ?? '';
  return windowedStat(`avg_over_time(${sel} | json${filter} | unwrap ${opts.field} [${opts.window}])`, opts.window);
}

// max(last_over_time(...)) — latest sample per group in the window. Used for
// context-pressure gauges and backpressure "now" stats (windowed-stat).
export function latestMax(opts: {
  kind: string;
  field: string;
  window: Window;
  by?: readonly string[];
  filter?: string;
}): Expr {
  const filter = opts.filter ?? '';
  const inner = `last_over_time(${telemetry(opts.kind)} | json${filter} | unwrap ${opts.field} [${opts.window}])`;
  const expr = opts.by && opts.by.length
    ? `max by (${opts.by.join(', ')}) (${inner})`
    : `max(${inner})`;
  return windowedStat(expr, opts.window);
}

// Cost-per-run ratio per model, per interval (intelligence weekly). Numerator
// and denominator both bind $__interval, so both integrate per step — a ratio
// of two per-step accumulations is itself a per-step series. Class windowed-stat
// because the emitted shape is a ratio, not a raw running total to integrate.
export const costPerRunByModelInterval = (): Expr => {
  const RUN = telemetry('run.complete');
  return windowedStat(
    `sum by (payload_model) (sum_over_time(${RUN} | json | unwrap payload_run_cost_usd [$__interval]))` +
      ` / sum by (payload_model) (count_over_time(${RUN} | json [$__interval]))`,
    '$__interval',
  );
};

// ---------------------------------------------------------------------------
// wire-latency raw-field quantiles (desktop/ios transport frames)
// ---------------------------------------------------------------------------

// quantile of a desktop/ios transport field, grouped by event_type.
export function transportQuantile(opts: {
  q: number;
  component: 'desktop' | 'ios';
  tag: string;
  field: string;
  window: Window;
}): Expr {
  const expr =
    `quantile_over_time(${opts.q}, {component="${opts.component}"} | json | tag="${opts.tag}"` +
    ` | ${opts.field} != "" | unwrap ${opts.field} [${opts.window}]) by (fields_event_type)`;
  return windowedStat(expr, opts.window);
}

// avg of the iOS heartbeat skew estimate over a window (windowed-stat).
// iOS emits skew on every receive-path frame under tag="transport.receive";
// the heartbeat frames carry msg="heartbeat received" with fields_skew_est_ms
// (TransportManager+Receive.swift). Filtering to the heartbeat msg isolates the
// clock-skew round-trips from ordinary data frames.
export const skewEstimateAvg = (window: Window): Expr =>
  windowedStat(
    `avg_over_time({component="ios"} | json | tag="transport.receive" | msg="heartbeat received"` +
      ` | fields_skew_est_ms != "" | unwrap fields_skew_est_ms [${window}])`,
    window,
  );

// DECODE-ERR frames/min: rolling count of transport decode errors per window on
// one component. windowed-stat (deliberate rolling window, pinned in title).
// The receive-path tag differs by component: the desktop logs decode/decompress
// failures under tag="transport" (transport.ts), iOS logs them under
// tag="transport.receive" (TransportManager+Receive.swift). The caller passes
// the correct tag for the component so each series matches its real emitter.
export const decodeErrorRate = (opts: {
  component: 'desktop' | 'ios';
  tag: string;
  msgPattern: string;
  window: Window;
}): Expr =>
  windowedStat(
    `sum(count_over_time({component="${opts.component}"} | json | level="ERROR" | tag="${opts.tag}"` +
      ` | msg=~"${opts.msgPattern}" [${opts.window}]))`,
    opts.window,
  );

// ---------------------------------------------------------------------------
// Instant windowed stats (single headline number)
// ---------------------------------------------------------------------------

// Instant quantile headline (e.g. hook latency p99 over 1h). A single headline
// number, so it always aggregates to one series: the same cardinality guard as
// `quantile` applies (ungrouped `quantile_over_time` over a `| json` stream
// fans out to one series per parsed label and trips Loki's 500-series limit).
// An explicit `by ()` collapses the fan-out to the single aggregate the stat
// panel renders.
export function quantileInstant(opts: {
  q: number;
  kind: string;
  field: string;
  window: Window;
  filter?: string;
}): Expr {
  const filter = opts.filter ?? '';
  return instant(
    `quantile_over_time(${opts.q}, ${telemetry(opts.kind)} | json${filter}` +
      ` | unwrap ${opts.field} [${opts.window}]) by ()`,
    opts.window,
  );
}
