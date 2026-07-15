// Recipe: Ion Wire Latency (uid ion-wire-latency-001).
//
// Per-event_type send/receive latency between desktop and iOS. Every metric
// panel is a legitimate windowed statistic (quantile/avg over a rolling window)
// or a rolling decode-error count — all class windowed-stat, so the fixed
// windows are correct by design. The window is NOT pinned in these titles
// (statistical smoothing convention: titles read "p50 / p95", not "(1m)").
// Migrated semantically-identical.

import type { Dashboard } from '../dashboard.ts';
import { text, timeseries } from '../panels.ts';
import { transportQuantile, skewEstimateAvg, decodeErrorRate } from '../queries-latency.ts';

const line = (unit: string, fillOpacity = 10) => ({
  defaults: { unit, custom: { lineWidth: 2, fillOpacity } },
  overrides: [],
});
const legend = () => ({
  tooltip: { mode: 'multi', sort: 'none' },
  legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
});

const INTRO =
  '## Ion Wire Latency\n\nPer-event_type send and receive latency between the desktop and iOS companion. **Desktop-send panels** show real-time data from `desktop.jsonl`. **iOS-receive panels** are bounded by the ~30 s diagnostic-log pull interval (see commit 10) — data may be up to 30 s stale.\n\nClock-skew correction is applied to iOS receive latency via a heartbeat-seeded exponential moving average (`adj_latency_ms = raw_latency_ms − skew_est_ms`).';

export function wireLatencyDashboard(): Dashboard {
  const panels = [
    { ...text(1, { h: 3, w: 24, x: 0, y: 0 }, INTRO), datasource: undefined },
    timeseries({
      id: 2,
      title: 'Desktop → iOS: send queue dwell by event_type (p50 / p95)',
      description:
        'Time from event entering the send queue to frame build, per event_type. High dwell indicates a blocked send queue (transport backpressure or slow encryption). Source: desktop.jsonl tag=transport-frame fields.queue_dwell_ms.',
      gridPos: { h: 8, w: 12, x: 0, y: 3 },
      fieldConfig: line('ms'),
      options: legend(),
      targets: [
        { e: transportQuantile({ q: 0.5, component: 'desktop', tag: 'transport-frame', field: 'fields_queue_dwell_ms', window: '1m' }), legend: 'p50 {{fields_event_type}}' },
        { e: transportQuantile({ q: 0.95, component: 'desktop', tag: 'transport-frame', field: 'fields_queue_dwell_ms', window: '1m' }), legend: 'p95 {{fields_event_type}}', refId: 'B' },
      ],
    }),
    timeseries({
      id: 3,
      title: 'Desktop → iOS: payload bytes by event_type (p50 / p95)',
      description:
        'Compressed payload size per outbound frame. Large payloads (snapshot, conversation_history) drive bandwidth usage. Source: desktop.jsonl tag=transport-frame fields.payload_bytes.',
      gridPos: { h: 8, w: 12, x: 12, y: 3 },
      fieldConfig: line('bytes'),
      options: legend(),
      targets: [
        { e: transportQuantile({ q: 0.5, component: 'desktop', tag: 'transport-frame', field: 'fields_payload_bytes', window: '1m' }), legend: 'p50 {{fields_event_type}}' },
        { e: transportQuantile({ q: 0.95, component: 'desktop', tag: 'transport-frame', field: 'fields_payload_bytes', window: '1m' }), legend: 'p95 {{fields_event_type}}', refId: 'B' },
      ],
    }),
    timeseries({
      id: 4,
      title: 'iOS receive: adjusted latency by event_type (p50 / p95)',
      description:
        'Clock-skew-corrected one-way latency from desktop frame-build to iOS decode, per event_type. adj_latency_ms = raw_latency_ms − skew_est_ms. Source: ios-diagnostic-logs.jsonl tag=transport.receive msg="frame received", bounded by ~30 s pull interval (freshness caveat).',
      gridPos: { h: 8, w: 12, x: 0, y: 11 },
      fieldConfig: line('ms'),
      options: legend(),
      targets: [
        { e: transportQuantile({ q: 0.5, component: 'ios', tag: 'transport.receive', field: 'fields_adj_latency_ms', window: '5m' }), legend: 'p50 {{fields_event_type}}' },
        { e: transportQuantile({ q: 0.95, component: 'ios', tag: 'transport.receive', field: 'fields_adj_latency_ms', window: '5m' }), legend: 'p95 {{fields_event_type}}', refId: 'B' },
      ],
    }),
    timeseries({
      id: 5,
      title: 'iOS receive: heartbeat clock-skew estimate over time',
      description:
        'The rolling clock-skew estimate (α=0.25 EMA) from heartbeat round-trips. A stable non-zero value is expected and normal — iOS and desktop clocks rarely agree perfectly. Rapid drift may indicate NTP problems on either device. Source: ios-diagnostic-logs.jsonl tag=transport.receive msg="heartbeat received".',
      gridPos: { h: 8, w: 12, x: 12, y: 11 },
      fieldConfig: line('ms'),
      options: legend(),
      targets: [{ e: skewEstimateAvg('5m'), legend: 'skew_est_ms (avg)' }],
    }),
    timeseries({
      id: 6,
      title: 'DECODE-ERR drop rate (frames/min)',
      description:
        'Number of incoming frames that failed JSON decode or schema validation per minute. A non-zero rate indicates a wire mismatch (possible version skew between desktop and iOS builds). Source: desktop.jsonl and ios-diagnostic-logs.jsonl. The desktop emits decode errors at ERROR level with tag=transport; iOS emits them at ERROR level with tag=transport.receive in TransportManager+Receive.swift.',
      gridPos: { h: 8, w: 24, x: 0, y: 19 },
      fieldConfig: {
        defaults: { unit: 'short', custom: { lineWidth: 2, fillOpacity: 20 } },
        overrides: [
          { matcher: { id: 'byName', options: 'decode errors (desktop)' }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: 'orange' } }] },
          { matcher: { id: 'byName', options: 'decode errors (ios)' }, properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: 'red' } }] },
        ],
      },
      options: legend(),
      targets: [
        { e: decodeErrorRate({ component: 'desktop', tag: 'transport', msgPattern: '.*(decode|decompress|JSON parse|failed to parse).*', window: '1m' }), legend: 'decode errors (desktop)' },
        { e: decodeErrorRate({ component: 'ios', tag: 'transport.receive', msgPattern: '.*(decode|decompression|JSON|failed to parse).*', window: '1m' }), legend: 'decode errors (ios)', refId: 'B' },
      ],
    }),
  ];

  return {
    uid: 'ion-wire-latency-001',
    title: 'Ion Wire Latency',
    description:
      'Wire latency between desktop and iOS — per-event_type send latency and iOS receive latency with clock-skew correction.\n\n**Freshness caveat:** iOS diagnostic logs are pulled periodically (~30 s per the commit-10 pull interval). Data on the iOS-receive panels may be up to ~30 s stale relative to actual receipt time. The desktop-send panels are real-time (logs land in desktop.jsonl immediately).',
    tags: ['ion', 'wire', 'latency', 'ios', 'transport'],
    schemaVersion: 38,
    version: 1,
    graphTooltip: 1,
    refresh: '30s',
    timeFrom: 'now-1h',
    folder: 'reliability',
    file: 'ion-wire-latency',
    panels,
    annotations: [
      { name: 'Desktop send frames', expr: '{component="desktop"} | json | tag="transport-frame"', iconColor: 'green', step: '60s', titleFormat: 'send: {{fields_event_type}} seq={{fields_seq}} dwell={{fields_queue_dwell_ms}}ms' },
      { name: 'iOS receive frames', expr: '{component="ios"} | json | tag="transport.receive" | msg="frame received"', iconColor: 'blue', step: '60s', titleFormat: 'recv: {{fields_event_type}} adj={{fields_adj_latency_ms}}ms' },
    ],
  };
}
