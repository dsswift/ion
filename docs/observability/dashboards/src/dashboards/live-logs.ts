// Recipe: Ion Live Logs (uid ion-logs).
//
// "What is Ion doing right now?" Verdict / right-now / evidence / drill-down.
//
// OVERCOUNT FIX (17-suspect class):
//   * Panel 7 "Extension log volume (1h, stacked)": was a [1h] accumulation on a
//     range timeseries — every step re-summed a full hour. The companion panel 6
//     "Per-extension activity (1m)" already does the same shape correctly with a
//     rolling [1m]. This panel is a per-interval volume trend, so it becomes a
//     $__interval accumulation. The title's "(1h)" referred to the (wrong) fixed
//     window; with the fix the panel plots per-interval volume over the
//     dashboard range, so the title drops the misleading "(1h)".
//     Panels 5/6 were "(1m)" rolling windowed-stats; ADR-022 converted them to
//     $__interval accumulations (a fixed rolling window undersamples once the
//     query step exceeds it at wide ranges).

import type { Dashboard } from '../dashboard.ts';
import { row, text, stat, timeseries, gauge, logs } from '../panels.ts';
import { stream } from '../queries.ts';
import { levelCount, allLinesCount, activeExtensionCount, logVolumeByComponentInterval, extensionVolumeInterval, kindCount } from '../queries-logs.ts';
import { quantile, latestMax } from '../queries-latency.ts';

const fixed = (steps: unknown[] = []) => ({ mode: 'absolute', steps });
const statOptions = (colorMode: string, graphMode = 'none') => ({
  reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
  orientation: 'auto',
  textMode: 'auto',
  colorMode,
  graphMode,
});
const legendBottom = (sort = true, multi = true) => ({
  legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
  tooltip: { mode: multi ? 'multi' : 'single', ...(sort ? { sort: 'desc' } : {}) },
});
const bars = (fillOpacity: number, draw = 'bars') => ({
  defaults: { unit: 'short', custom: { drawStyle: draw, fillOpacity, stacking: { mode: draw === 'lines' ? 'none' : 'normal', ...(draw === 'lines' ? {} : { group: 'A' }) } } },
  overrides: [],
});

const INTRO =
  '## What is Ion doing right now?\n\nThis dashboard shows live activity across all Ion surfaces. **Verdict row**: log volume and active extension count at a glance. **Evidence row**: volume by component over time. **Right now row**: context pressure per session, dispatches in flight, TTFT, and backpressure. **Drill-down**: live log tail and per-extension activity.\n\nUse this dashboard when Ion is running a long task and you want to watch it. The live log tail at the bottom auto-refreshes every 30s. Filter by component (engine, extension, desktop, ios) using LogQL in Explore for deeper drill-down.\n\n> **Right now panels empty?** The context-pressure, dispatch, TTFT, and backpressure gauges require the Phase-B engine rebuild. Queries are valid; data appears once that ships.';

export function liveLogsDashboard(): Dashboard {
  const panels = [
    text(1, { h: 3, w: 24, x: 0, y: 0 }, INTRO),
    stat({
      id: 2,
      title: 'Log lines',
      gridPos: { h: 4, w: 8, x: 0, y: 3 },
      fieldConfig: { defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: fixed(), mappings: [] }, overrides: [] },
      options: statOptions('value'),
      targets: [{ e: allLinesCount('$__range') }],
    }),
    stat({
      id: 3,
      title: 'Errors',
      gridPos: { h: 4, w: 8, x: 8, y: 3 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'orange', value: 1 },
            { color: 'red', value: 5 },
          ]),
          mappings: [],
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: levelCount('ERROR', '$__range') }],
    }),
    stat({
      id: 4,
      title: 'Active extensions',
      gridPos: { h: 4, w: 8, x: 16, y: 3 },
      fieldConfig: { defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: fixed(), mappings: [] }, overrides: [] },
      options: statOptions('value'),
      targets: [{ e: activeExtensionCount('$__range') }],
    }),
    row(10, 'Right now', 7),
    gauge({
      id: 11,
      title: 'Context pressure (latest, per session)',
      description:
        'Percent of context window used, latest value in the last 10 minutes per session. Green < 60%, amber 60-80%, red > 80% (compact trigger zone). Samples where payload_estimated=true are heuristic (no real token count available). Click a session value to open forensics. Data empty until Phase-B.',
      gridPos: { h: 8, w: 8, x: 0, y: 8 },
      fieldConfig: {
        defaults: {
          unit: 'percent',
          min: 0,
          max: 100,
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'yellow', value: 60 },
            { color: 'red', value: 80 },
          ]),
          mappings: [],
          links: [{ title: 'Open forensics for this session', url: '/d/ion-forensics/ion-conversation-forensics?var-session=${__field.labels.context_session_id}&${__url_time_range}' }],
        },
        overrides: [],
      },
      options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true }, orientation: 'auto', showThresholdLabels: false, showThresholdMarkers: true },
      targets: [{ e: latestMax({ kind: 'context.pressure', field: 'payload_percent', window: '10m', by: ['context_session_id'] }), legend: '{{context_session_id}}' }],
    }),
    stat({
      id: 12,
      title: 'Dispatches in flight (5m)',
      description:
        'Count of dispatch.agent span-end events in the last 5 minutes. These are recently completed dispatches, not true in-flight spans (span-end events are what land in Loki). For true in-flight view, use the Tempo panel in the forensics pack. Data empty until Phase-B.',
      gridPos: { h: 4, w: 8, x: 8, y: 8 },
      fieldConfig: { defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: fixed(), mappings: [] }, overrides: [] },
      options: statOptions('value', 'area'),
      targets: [{ e: kindCount('dispatch.agent', '5m', true) }],
    }),
    stat({
      id: 13,
      title: 'Client backpressure now',
      description:
        'Maximum dropped event count across all client queues in the last 10 minutes. Zero is the only good number. Data empty until Phase-B.',
      gridPos: { h: 4, w: 8, x: 8, y: 12 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'red', value: 1 },
          ]),
          mappings: [],
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: latestMax({ kind: 'client.backpressure', field: 'payload_dropped_total', window: '10m' }) }],
    }),
    timeseries({
      id: 14,
      title: 'TTFT last hour (p50 sparkline)',
      description:
        'Streaming time-to-first-token, p50 over the selected interval. A rising trend mid-session means providers are responding slower. Data empty until Phase-B.',
      gridPos: { h: 8, w: 8, x: 16, y: 8 },
      fieldConfig: { defaults: { unit: 'ms', custom: { drawStyle: 'line', fillOpacity: 20, lineWidth: 2, stacking: { mode: 'none' } } }, overrides: [] },
      options: legendBottom(false, false),
      targets: [{ e: quantile({ q: 0.5, kind: 'provider.ttft', field: 'payload_ttft_ms', window: '$__interval' }), legend: 'TTFT p50' }],
    }),
    timeseries({
      id: 5,
      title: 'Log volume by component',
      gridPos: { h: 8, w: 24, x: 0, y: 16 },
      fieldConfig: bars(70),
      options: legendBottom(true),
      targets: [{ e: logVolumeByComponentInterval(), legend: '{{component}}' }],
    }),
    timeseries({
      id: 6,
      title: 'Per-extension activity',
      gridPos: { h: 8, w: 12, x: 0, y: 24 },
      fieldConfig: bars(10, 'lines'),
      options: legendBottom(true),
      targets: [{ e: extensionVolumeInterval(), legend: '{{tag}}' }],
    }),
    timeseries({
      id: 7,
      title: 'Extension log volume (stacked)',
      gridPos: { h: 8, w: 12, x: 12, y: 24 },
      fieldConfig: bars(60),
      options: legendBottom(true),
      targets: [{ e: extensionVolumeInterval(), legend: '{{tag}}' }],
    }),
    logs({
      id: 8,
      title: 'Live log tail',
      gridPos: { h: 12, w: 24, x: 0, y: 32 },
      target: { e: stream('{component=~".+"}') },
    }),
    logs({
      id: 9,
      title: 'Extension activity log',
      gridPos: { h: 10, w: 24, x: 0, y: 44 },
      options: {
        showTime: true,
        showLabels: true,
        showCommonLabels: false,
        wrapLogMessage: true,
        prettifyLogMessage: false,
        enableLogDetails: true,
        dedupStrategy: 'none',
        sortOrder: 'Descending',
      },
      target: { e: stream('{component="extension"}') },
    }),
  ];

  return {
    uid: 'ion-logs',
    title: 'Ion Live Logs',
    description: 'Ion live logs — what is Ion doing right now?',
    tags: ['ion', 'live'],
    schemaVersion: 39,
    version: 4,
    refresh: '10s',
    timeFrom: 'now-1h',
    folder: 'live',
    file: 'ion-logs',
    panels,
    annotations: [
      { name: 'Model fallback', expr: '{service_name="ion-telemetry", kind="provider.fallback"} | json', iconColor: 'orange', step: '60s', titleFormat: 'fallback: {{payload_requested_model}} -> {{payload_fallback_model}}' },
      { name: 'Compaction', expr: '{service_name="ion-telemetry", kind="compaction"} | json', iconColor: 'blue', step: '60s', titleFormat: 'compaction: {{payload_trigger}}' },
    ],
  };
}
