// Span metrics: PromQL against the Prometheus datasource.
//
// Durations become distributions in Tempo, not in app code (the design
// principle behind the span instrumentation): every span Ion emits reaches
// Tempo, whose metrics-generator turns it into a latency histogram and a call
// counter, remote-written to Prometheus (tempo-config.yaml `metrics_generator`):
//
//   traces_spanmetrics_latency_bucket{service, span_name, span_kind, status_code, <dimensions>, le}
//   traces_spanmetrics_calls_total{service, span_name, span_kind, status_code, <dimensions>}
//
// `service` is the OTLP resource service.name (`ion-engine`, `ion-extension`);
// `span_name` is the span name docs/observability/log-schema.md § "Spans"
// lists. The dimensions are the span attributes the config names (`backend`,
// `model`, `command`) plus the identity pair every dashboard scopes on
// (`host.name`, `user`, written `host_name` and `user`). Latency is in seconds.
//
// Every expression here is class `windowed-stat` (a rate or a quantile over a
// rolling window) or `instant` (one headline number over `$__range`); none is
// an accumulation, so the overcount guard has nothing to refuse.

import type { Expr } from './types.ts';
import { registerQuery } from './queries.ts';

const LATENCY = 'traces_spanmetrics_latency_bucket';
const CALLS = 'traces_spanmetrics_calls_total';

/** Which spans an expression reads. Arrays become a regex matcher. */
export interface SpanSelector {
  readonly span: string | readonly string[];
  readonly service?: string | readonly string[];
  // Extra matchers, already in PromQL form (`backend=~"$backend"`).
  readonly extra?: readonly string[];
}

function matcher(label: string, value: string | readonly string[]): string {
  return typeof value === 'string' ? `${label}="${value}"` : `${label}=~"${value.join('|')}"`;
}

export function spanSelector(sel: SpanSelector): string {
  const parts = [matcher('span_name', sel.span)];
  if (sel.service !== undefined) parts.push(matcher('service', sel.service));
  if (sel.extra) parts.push(...sel.extra);
  return `{${parts.join(', ')}}`;
}

const groupBy = (by?: readonly string[]) => (by && by.length ? `, ${by.join(', ')}` : '');

/**
 * A latency quantile over a rolling window, per step, grouped as asked. The
 * window is `$__rate_interval` so `rate()` always spans two scrapes.
 */
export function spanQuantile(opts: { q: number; sel: SpanSelector; by?: readonly string[] }): Expr {
  return {
    expr: `histogram_quantile(${opts.q}, sum by (le${groupBy(opts.by)}) (rate(${LATENCY}${spanSelector(opts.sel)}[$__rate_interval])))`,
    cls: 'windowed-stat',
    window: '$__rate_interval',
    datasource: 'prometheus',
  };
}

/** One headline quantile over the whole dashboard range (a stat or a table). */
export function spanQuantileInstant(opts: { q: number; sel: SpanSelector; by?: readonly string[] }): Expr {
  return {
    expr: `histogram_quantile(${opts.q}, sum by (le${groupBy(opts.by)}) (rate(${LATENCY}${spanSelector(opts.sel)}[$__range])))`,
    cls: 'instant',
    window: '$__range',
    datasource: 'prometheus',
  };
}

/** Spans per second, grouped as asked. */
export function spanRate(opts: { sel: SpanSelector; by?: readonly string[] }): Expr {
  const by = opts.by && opts.by.length ? ` by (${opts.by.join(', ')})` : '';
  return {
    expr: `sum${by} (rate(${CALLS}${spanSelector(opts.sel)}[$__rate_interval]))`,
    cls: 'windowed-stat',
    window: '$__rate_interval',
    datasource: 'prometheus',
  };
}

// Named for the generated reference doc (queries.md).
registerQuery(
  'Span latency p95 by span name (span metrics)',
  'p95 of one service\'s spans per step, one series per span name, from the histogram Tempo\'s metrics-generator ' +
    'writes to Prometheus. Swap the service, the quantile, or the grouping (`model`, `backend`, `command`). Seconds.',
  spanQuantile({ q: 0.95, sel: { span: ['.+'], service: 'ion-engine' }, by: ['span_name'] }),
);
registerQuery(
  'Cold start p95 over the dashboard range (span metrics)',
  'One headline number for a start-up span over the whole range: `daemon.startup`, `session.start`, ' +
    '`extension.spawn`, `mcp.start` (all engine).',
  spanQuantileInstant({ q: 0.95, sel: { span: 'daemon.startup', service: 'ion-engine' } }),
);
