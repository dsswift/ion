// Recipe: Ion Errors & Health (uid ion-errors-health).
//
// "Is Ion healthy?" Verdict / evidence / drill-down over engine logs, plus the
// Tier-4 provider-market and platform-health rows.
//
// OVERCOUNT FIX (17-suspect class):
//   * Panel 8 "Top error sources": was a [24h] accumulation on a range
//     timeseries — a ranked "top sources over 24h" plotted as a per-step series
//     re-summed the whole 24h at every step. It is a snapshot, not a trend, so
//     it becomes an INSTANT bargauge. Panels 6/7 were "(5m)" rolling counts;
//     ADR-022 converted them to $__interval accumulations because a fixed
//     rolling window undersamples once the query step exceeds it at wide ranges.

import type { Dashboard } from '../dashboard.ts';
import { row, text, stat, timeseries, logs, bargauge, table } from '../panels.ts';
import { stream } from '../queries.ts';
import { levelCount, allLinesCount, errorRate, levelSeriesInterval, errorsByComponentInterval, topErrorSources, kindCount, groupedKindSeries } from '../queries-logs.ts';
import { quantile, latestMax } from '../queries-latency.ts';
import { accumulation, telemetry } from '../queries.ts';

const fixed = (steps: unknown[] = []) => ({ mode: 'absolute', steps });
const statOptions = (colorMode: string) => ({
  reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
  orientation: 'auto',
  textMode: 'auto',
  colorMode,
  graphMode: 'none',
});
const bars = (fillOpacity: number) => ({
  defaults: { unit: 'short', custom: { drawStyle: 'bars', fillOpacity, stacking: { mode: 'normal', group: 'A' } } },
  overrides: [],
});
const line = (unit: string) => ({
  defaults: { unit, custom: { drawStyle: 'line', fillOpacity: 10, lineWidth: 2, stacking: { mode: 'none' } } },
  overrides: [],
});
const legendBottom = (sort = true) => ({
  legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
  tooltip: { mode: 'multi', ...(sort ? { sort: 'desc' } : {}) },
});
const link = (title: string, url: string) => [{ title, url }];

const INTRO =
  '## Is Ion healthy?\n\nVerdict: error and warning counts over the dashboard time range. Evidence: error rate over time and by component. Drill-down: recent error log lines with full JSON detail.\n\nRead the verdict row first. If errors are 0 and warnings are low, Ion is healthy. Use the error-by-component timeseries to spot which surface is noisy. Use the live error stream at the bottom to read the raw log lines.\n\n---\n\n**Below the error line.** Errors in the log are the loud failures. The rows below track the quiet ones: providers that stall mid-stream and get retried, models that silently fall back to cheaper ones, extensions that die and respawn on a strike budget, and clients too slow to keep up with the event stream. These degrade the experience without writing a single ERROR line.\n\n> **Tier-4 panels empty?** Provider market and platform health panels require the Phase-B engine rebuild. Queries are valid; data appears once the instrumented engine ships.';

export function errorsHealthDashboard(): Dashboard {
  const panels = [
    text(1, { h: 4, w: 24, x: 0, y: 0 }, INTRO),
    stat({
      id: 2,
      title: 'Errors',
      gridPos: { h: 4, w: 6, x: 0, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'orange', value: 1 },
            { color: 'red', value: 10 },
          ]),
          mappings: [],
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: levelCount('ERROR', '$__range', true) }],
    }),
    stat({
      id: 3,
      title: 'Warnings',
      gridPos: { h: 4, w: 6, x: 6, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'yellow', value: 5 },
            { color: 'orange', value: 20 },
          ]),
          mappings: [],
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: levelCount('WARN', '$__range', true) }],
    }),
    stat({
      id: 4,
      title: 'Error Rate',
      gridPos: { h: 4, w: 6, x: 12, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'percentunit',
          decimals: 2,
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'yellow', value: 0.01 },
            { color: 'red', value: 0.05 },
          ]),
          mappings: [],
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: errorRate('$__range') }],
    }),
    stat({
      id: 5,
      title: 'Log lines',
      gridPos: { h: 4, w: 6, x: 18, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'fixed', fixedColor: 'blue' },
          thresholds: fixed(),
          mappings: [],
        },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: allLinesCount('$__range') }],
    }),
    timeseries({
      id: 6,
      title: 'Errors vs Warnings over time',
      gridPos: { h: 8, w: 24, x: 0, y: 8 },
      fieldConfig: {
        defaults: { unit: 'short', custom: { drawStyle: 'line', fillOpacity: 15, lineWidth: 2, stacking: { mode: 'none' } } },
        overrides: [
          { matcher: { id: 'byName', options: 'errors' }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: 'red' } }] },
          { matcher: { id: 'byName', options: 'warnings' }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: 'orange' } }] },
        ],
      },
      options: legendBottom(true),
      targets: [
        { e: levelSeriesInterval('ERROR'), legend: 'errors', refId: 'A' },
        { e: levelSeriesInterval('WARN'), legend: 'warnings', refId: 'B' },
      ],
    }),
    timeseries({
      id: 7,
      title: 'Error volume by component',
      gridPos: { h: 8, w: 24, x: 0, y: 16 },
      fieldConfig: bars(80),
      options: legendBottom(true),
      targets: [{ e: errorsByComponentInterval(), legend: '{{component}}' }],
    }),
    bargauge({
      id: 8,
      title: 'Top error sources — by component and tag',
      gridPos: { h: 8, w: 12, x: 0, y: 24 },
      fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
      options: { orientation: 'horizontal', reduceOptions: { calcs: ['sum'] }, displayMode: 'gradient', showUnfilled: true },
      targets: [{ e: topErrorSources('$__range'), legend: '{{component}} / {{tag}}' }],
    }),
    logs({
      id: 9,
      title: 'Recent errors',
      gridPos: { h: 8, w: 12, x: 12, y: 24 },
      target: { e: stream('{level="ERROR"}') },
    }),
    logs({
      id: 10,
      title: 'Live error and warning stream',
      gridPos: { h: 10, w: 24, x: 0, y: 32 },
      target: { e: stream('{level=~"ERROR|WARN"}') },
    }),
    row(20, 'Provider market (Tier-4)', 42),
    stat({
      id: 21,
      title: 'Retries',
      description: 'Count of provider.retry events. Data empty until Phase-B engine rebuild ships.',
      gridPos: { h: 4, w: 4, x: 0, y: 43 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'yellow', value: 5 },
            { color: 'red', value: 20 },
          ]),
          mappings: [],
          links: link('Retry causes', '/d/ion-errors-health/ion-errors-health?viewPanel=24'),
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: kindCount('provider.retry', '$__range', true) }],
    }),
    stat({
      id: 22,
      title: 'Stalls',
      description: 'Count of provider.stall events (intra-stream gap threshold exceeded). Data empty until Phase-B.',
      gridPos: { h: 4, w: 4, x: 4, y: 43 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'yellow', value: 3 },
            { color: 'red', value: 10 },
          ]),
          mappings: [],
          links: link('Worst intra-stream gap', '/d/ion-errors-health/ion-errors-health?viewPanel=26'),
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: kindCount('provider.stall', '$__range', true) }],
    }),
    stat({
      id: 23,
      title: 'Fallbacks',
      description: 'Count of provider.fallback events. Click to see fallback cost routes in the cost pack.',
      gridPos: { h: 4, w: 4, x: 8, y: 43 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'yellow', value: 2 },
            { color: 'red', value: 10 },
          ]),
          mappings: [],
          links: link('Fallback cost routes', '/d/ion-cost/ion-cost?viewPanel=16'),
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: kindCount('provider.fallback', '$__range', true) }],
    }),
    timeseries({
      id: 24,
      title: 'Retry causes',
      description: 'Retry events grouped by payload_error_code (ProviderError constants). Data empty until Phase-B.',
      gridPos: { h: 8, w: 12, x: 12, y: 43 },
      fieldConfig: bars(70),
      options: legendBottom(true),
      targets: [{ e: groupedKindSeries('provider.retry', ['payload_error_code']), legend: '{{payload_error_code}}' }],
    }),
    timeseries({
      id: 25,
      title: 'TTFT p95 by model',
      description: 'Time-to-first-token p95, grouped by model. Data empty until Phase-B.',
      gridPos: { h: 8, w: 12, x: 0, y: 51 },
      fieldConfig: line('ms'),
      options: legendBottom(true),
      targets: [{ e: quantile({ q: 0.95, kind: 'provider.ttft', field: 'payload_ttft_ms', window: '$__interval', by: ['payload_model'] }), legend: '{{payload_model}} p95' }],
    }),
    timeseries({
      id: 26,
      title: 'Worst intra-stream gap p99',
      description: 'Tail stall signal: max gap between consecutive token events during a stream. Data empty until Phase-B.',
      gridPos: { h: 8, w: 12, x: 12, y: 51 },
      fieldConfig: line('ms'),
      options: legendBottom(true),
      targets: [{ e: quantile({ q: 0.99, kind: 'provider.stream_summary', field: 'payload_max_gap_ms', window: '$__interval', by: ['payload_model'] }), legend: '{{payload_model}} p99 max gap' }],
    }),
    row(30, 'Platform health (Tier-4)', 59),
    timeseries({
      id: 31,
      title: 'Extension respawns by extension',
      description: 'Count of extension.respawn events per extension. Rising count signals instability. Data empty until Phase-B.',
      gridPos: { h: 8, w: 12, x: 0, y: 60 },
      fieldConfig: bars(70),
      options: legendBottom(true),
      targets: [{ e: groupedKindSeries('extension.respawn', ['payload_extension']), legend: '{{payload_extension}}' }],
    }),
    stat({
      id: 32,
      title: 'Budget-exceeded deaths',
      description:
        'Extensions that exhausted their respawn strike budget and did not recover. Any nonzero value warrants investigation. Data empty until Phase-B.',
      gridPos: { h: 4, w: 6, x: 12, y: 60 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'red', value: 1 },
          ]),
          mappings: [],
          links: link('Respawn detail', '/d/ion-errors-health/ion-errors-health?viewPanel=36'),
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [
        {
          e: accumulation(
            `sum(count_over_time(${telemetry('extension.respawn')} | json | payload_outcome="budget_exceeded" [$__range]))`,
            '$__range',
          ),
        },
      ],
    }),
    timeseries({
      id: 33,
      title: 'Cold-start p95 by extension',
      description:
        'Time from extension process launch to ready state, p95. Persistent high values suggest startup bottlenecks. Data empty until Phase-B.',
      gridPos: { h: 8, w: 18, x: 6, y: 64 },
      fieldConfig: line('ms'),
      options: legendBottom(true),
      targets: [{ e: quantile({ q: 0.95, kind: 'extension.coldstart', field: 'payload_ready_ms', window: '$__interval', by: ['payload_extension'] }), legend: '{{payload_extension}} p95' }],
    }),
    timeseries({
      id: 34,
      title: 'Client backpressure (dropped events)',
      description:
        'Cumulative dropped event count per queue. Zero is the only good number. Note: ack RTT is not measurable today (D3 §4e.5); this is a drop/saturation gauge only. Data empty until Phase-B.',
      gridPos: { h: 8, w: 12, x: 0, y: 72 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'red', value: 1 },
          ]),
          custom: { drawStyle: 'line', fillOpacity: 20, lineWidth: 2 },
        },
        overrides: [],
      },
      options: legendBottom(true),
      targets: [{ e: latestMax({ kind: 'client.backpressure', field: 'payload_dropped_total', window: '$__interval', by: ['payload_queue'] }), legend: '{{payload_queue}}' }],
    }),
    table({
      id: 36,
      title: 'Respawn detail (range)',
      description:
        'Full respawn event table with preceding_operation, exit_signal, and outcome. Rows with outcome=budget_exceeded are terminal failures. Data empty until Phase-B.',
      gridPos: { h: 8, w: 12, x: 12, y: 72 },
      mode: 'range',
      fieldConfig: {
        defaults: { unit: 'short', custom: { align: 'auto', displayMode: 'auto' } },
        overrides: [
          { matcher: { id: 'byName', options: 'payload_outcome' }, properties: [{ id: 'custom.displayMode', value: 'color-background' }] },
        ],
      },
      options: { footer: { show: false }, sortBy: [{ displayName: 'Time', desc: true }] },
      transformations: [
        {
          id: 'extractFields',
          options: {
            source: 'labels',
            format: 'auto',
            fields: [
              { name: 'payload_extension' },
              { name: 'payload_attempt' },
              { name: 'payload_budget_max' },
              { name: 'payload_preceding_operation' },
              { name: 'payload_exit_signal' },
              { name: 'payload_outcome' },
            ],
          },
        },
      ],
      targets: [{ e: stream('{service_name="ion-telemetry", kind="extension.respawn"} | json') }],
    }),
  ];

  return {
    uid: 'ion-errors-health',
    title: 'Ion Errors & Health',
    description: 'Ion errors and health — is Ion healthy?',
    tags: ['ion', 'reliability'],
    schemaVersion: 39,
    version: 4,
    refresh: '30s',
    timeFrom: 'now-24h',
    folder: 'reliability',
    file: 'ion-errors-health',
    panels,
    annotations: [
      { name: 'Model fallback', expr: '{service_name="ion-telemetry", kind="provider.fallback"} | json', iconColor: 'orange', step: '60s', titleFormat: 'fallback: {{payload_requested_model}} -> {{payload_fallback_model}} ({{payload_reason}})' },
      { name: 'Compaction', expr: '{service_name="ion-telemetry", kind="compaction"} | json', iconColor: 'blue', step: '60s', titleFormat: 'compaction: {{payload_trigger}} tokens_reclaimed={{payload_tokens_reclaimed}}' },
      { name: 'Extension respawn', expr: '{service_name="ion-telemetry", kind="extension.respawn"} | json', iconColor: 'red', step: '60s', titleFormat: 'respawn: {{payload_extension}} attempt {{payload_attempt}}/{{payload_budget_max}}' },
    ],
  };
}

