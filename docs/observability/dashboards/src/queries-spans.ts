// Span metrics and relay metrics: PromQL against the Prometheus datasource.
//
// Durations become distributions in Tempo, not in app code (the design
// principle behind the span instrumentation): every span Ion emits reaches
// Tempo, whose metrics-generator turns it into a latency histogram and a call
// counter, remote-written to Prometheus (tempo-config.yaml `metrics_generator`):
//
//   traces_spanmetrics_latency_bucket{service, span_name, span_kind, status_code, <dimensions>, le}
//   traces_spanmetrics_calls_total{service, span_name, span_kind, status_code, <dimensions>}
//
// `service` is the OTLP resource service.name (`ion-engine`, `ion-server`,
// `ion-desktop`, `ion-web`, `ion-ios`, `ion-relay`); `span_name` is the span
// name docs/observability/log-schema.md § "Spans" lists. The dimensions are the
// span attributes the config names (`backend`, `model`, `transport`,
// `client_kind`, `action`, `command`, `surface`, `direction`) plus the identity
// pair every dashboard scopes on (`host.name`, `user`, written `host_name` and
// `user`). Latency is in seconds.
//
// The relay also serves its own Prometheus metrics (relay/metrics.go), scraped
// by prometheus.yml: `relay_forward_seconds{direction}` and
// `relay_ping_rtt_seconds` are histograms with the usual `_bucket` series.
// Their selector is `le=~".+"`, a matcher every bucket series satisfies, so
// the query does not depend on the scrape job's name and the identity
// matchers have a selector to join.
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

/** A quantile of one of the relay's own histograms (`relay_*_seconds`). */
export function relayQuantile(opts: { q: number; metric: 'relay_forward_seconds' | 'relay_ping_rtt_seconds'; by?: readonly string[] }): Expr {
  return {
    expr: `histogram_quantile(${opts.q}, sum by (le${groupBy(opts.by)}) (rate(${opts.metric}_bucket{le=~".+"}[$__rate_interval])))`,
    cls: 'windowed-stat',
    window: '$__rate_interval',
    datasource: 'prometheus',
  };
}

// Named for the generated reference doc (queries.md).
registerQuery(
  'Span latency p95 by span name (span metrics)',
  'p95 of one service\'s spans per step, one series per span name, from the histogram Tempo\'s metrics-generator ' +
    'writes to Prometheus. Swap the service, the quantile, or the grouping (`model`, `backend`, `action`, `command`, ' +
    '`surface`, `transport`, `client_kind`, `direction`). Seconds.',
  spanQuantile({ q: 0.95, sel: { span: ['.+'], service: 'ion-engine' }, by: ['span_name'] }),
);
registerQuery(
  'Store action p95 by action (span metrics)',
  'p95 of the server\'s `action.handle` span per store action: the server\'s own time on one Studio action, from ' +
    'receipt to the result sent. The Performance alert "Ion store action p95 over 500 ms" reads the ungrouped form.',
  spanQuantile({ q: 0.95, sel: { span: 'action.handle', service: 'ion-server' }, by: ['action'] }),
);
registerQuery(
  'Cold start p95 over the dashboard range (span metrics)',
  'One headline number for a start-up span over the whole range: `daemon.startup` (engine), `app.launch` ' +
    '(desktop and iOS, told apart by `service`), `extension.spawn` (engine).',
  spanQuantileInstant({ q: 0.95, sel: { span: 'daemon.startup', service: 'ion-engine' } }),
);
registerQuery(
  'Span rate by surface (span metrics)',
  'Spans per second from the call counter, here `action.handle` split by the Studio surface that sent the action.',
  spanRate({ sel: { span: 'action.handle', service: 'ion-server' }, by: ['surface'] }),
);
registerQuery(
  'Relay forward p95 by direction (relay metrics)',
  'p95 of the relay\'s own `relay_forward_seconds` histogram, per direction (`mobile_to_ion`, `ion_to_mobile`), ' +
    'scraped from the relay\'s metrics endpoint. The `relay.forward` span gives the same figure through span metrics.',
  relayQuantile({ q: 0.95, metric: 'relay_forward_seconds', by: ['direction'] }),
);
