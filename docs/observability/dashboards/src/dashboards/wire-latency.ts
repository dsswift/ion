// Recipe: Ion Wire Latency (uid ion-wire-latency-001).
//
// How long the Studio wire takes, per connected client. Two sources, one
// picture: the server writes a `wire window` line per connection per minute
// (round trip, queue wait, bytes, frames, decode errors, its own time per
// action), and each client writes a `client window` line for the action
// latency a person actually waits through. A low server time beside a high
// client time is the wire, not the work.
//
// Every panel is a windowed statistic over a rolling window, which is correct
// by design for this dashboard — the window is not pinned in the titles
// (statistical smoothing convention: "p50 / p95", not "(1m)").
//
// This replaced a set of panels that timed desktop→iOS transport frames. That
// transport is gone (ADR-035 put every client on the Studio wire), nothing had
// emitted those fields since, and a dashboard reading them looked exactly like
// a quiet system. Its test now fails if a panel queries a field nothing emits.

import type { Dashboard } from '../dashboard.ts';
import { text, timeseries } from '../panels.ts';
import { wireWindowStat, wireWindowRate, clientWindowStat } from '../queries-latency.ts';

const line = (unit: string, fillOpacity = 10) => ({
  defaults: { unit, custom: { lineWidth: 2, fillOpacity } },
  overrides: [],
});
const legend = () => ({
  tooltip: { mode: 'multi', sort: 'none' },
  legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
});

const INTRO =
  '## Ion Wire Latency\n\nHow long the Studio wire takes, per client. **Server panels** time a round trip on the server\'s own clock (`studio_ping`/`studio_pong`), so there is no clock skew between machines to correct, and they read the same for Studio, a browser and a phone, over a local socket, TCP or a relay.\n\n**Client panels** show what a person waits through: an action leaving the client and its result arriving back. A low server time beside a high client time is the wire, not the work.\n\niOS lines arrive through the diagnostic-log pull, so they may be up to ~30 s behind; server and desktop lines are current.';

export function wireLatencyDashboard(): Dashboard {
  const panels = [
    { ...text(1, { h: 4, w: 24, x: 0, y: 0 }, INTRO), datasource: undefined },
    timeseries({
      id: 2,
      title: 'Round trip to each client (p50 / p95)',
      description:
        'Server-timed `studio_ping` → `studio_pong`, per client kind. One clock, both readings — no skew correction. Source: server.jsonl tag=wire-latency msg="wire window" fields.rtt_p50_ms / rtt_p95_ms.',
      gridPos: { h: 8, w: 12, x: 0, y: 4 },
      fieldConfig: line('ms'),
      options: legend(),
      targets: [
        { e: wireWindowStat({ field: 'fields_rtt_p50_ms', window: '5m' }), legend: 'p50 {{fields_client_kind}}' },
        { e: wireWindowStat({ field: 'fields_rtt_p95_ms', window: '5m' }), legend: 'p95 {{fields_client_kind}}', refId: 'B' },
      ],
    }),
    timeseries({
      id: 3,
      title: 'Probes lost per window',
      description:
        'Probes a client never answered within the timeout. A non-zero line is a client that is connected but not reading its socket. Source: server.jsonl fields.pings_lost.',
      gridPos: { h: 8, w: 12, x: 12, y: 4 },
      fieldConfig: line('short', 20),
      options: legend(),
      targets: [{ e: wireWindowRate({ field: 'fields_pings_lost', window: '5m' }), legend: '{{fields_client_kind}}' }],
    }),
    timeseries({
      id: 4,
      title: 'Outbound queue wait (p95)',
      description:
        'How long a frame sat between entering the send queue and leaving the socket. High wait means backpressure on this connection, not a slow network. Source: server.jsonl fields.dwell_p95_ms.',
      gridPos: { h: 8, w: 12, x: 0, y: 12 },
      fieldConfig: line('ms'),
      options: legend(),
      targets: [{ e: wireWindowStat({ field: 'fields_dwell_p95_ms', window: '5m' }), legend: 'p95 {{fields_client_kind}}' }],
    }),
    timeseries({
      id: 5,
      title: 'Peak send-queue depth',
      description:
        'The deepest the bounded send queue got in the window. A connection that crosses its cap is closed with slow_client, so this climbing is the warning before that. Source: server.jsonl fields.queue_max.',
      gridPos: { h: 8, w: 12, x: 12, y: 12 },
      fieldConfig: line('bytes'),
      options: legend(),
      targets: [{ e: wireWindowStat({ field: 'fields_queue_max', window: '5m' }), legend: '{{fields_client_kind}}' }],
    }),
    timeseries({
      id: 6,
      title: 'Bytes out per window',
      description:
        'Outbound volume per client kind. A phone on a relay paying for a snapshot shows up here. Source: server.jsonl fields.bytes_out.',
      gridPos: { h: 8, w: 12, x: 0, y: 20 },
      fieldConfig: line('bytes'),
      options: legend(),
      targets: [{ e: wireWindowRate({ field: 'fields_bytes_out', window: '5m' }), legend: '{{fields_client_kind}}' }],
    }),
    timeseries({
      id: 7,
      title: 'Server time per action (p95)',
      description:
        'The server\'s own work on one studio_action, receipt to result sent — the wire is not in this number. Compare against the client-felt panel below: the gap between them is the wire. Source: server.jsonl fields.action_p95_ms.',
      gridPos: { h: 8, w: 12, x: 12, y: 20 },
      fieldConfig: line('ms'),
      options: legend(),
      targets: [{ e: wireWindowStat({ field: 'fields_action_p95_ms', window: '5m' }), legend: 'p95 {{fields_client_kind}}' }],
    }),
    timeseries({
      id: 8,
      title: 'Client-felt action latency (p50 / p95)',
      description:
        'What a person waits through: an action leaving the client and its result arriving back, from each client\'s own window. desktop = Studio and Electron main; web = a browser tab (forwarded through POST /log); ios = the phone (through its diagnostic pull, so up to ~30 s behind). Source: each client\'s log, tag=wire-latency msg="client window".',
      gridPos: { h: 8, w: 12, x: 0, y: 28 },
      fieldConfig: line('ms'),
      options: legend(),
      targets: [
        { e: clientWindowStat({ field: 'fields_action_p50_ms', window: '5m' }), legend: 'p50 {{service_name}}' },
        { e: clientWindowStat({ field: 'fields_action_p95_ms', window: '5m' }), legend: 'p95 {{service_name}}', refId: 'B' },
      ],
    }),
    timeseries({
      id: 9,
      title: 'Client action timeouts, and server decode errors',
      description:
        'Two ways the wire fails rather than slows. Timeouts are actions a client gave up on, counted separately from the percentiles so a 30 s wait does not read as merely sluggish. Decode errors are frames the server could not parse — a version skew between a client and this server. Sources: client windows fields.action_timeouts; server windows fields.decode_errors.',
      gridPos: { h: 8, w: 12, x: 12, y: 28 },
      fieldConfig: {
        defaults: { unit: 'short', custom: { lineWidth: 2, fillOpacity: 20 } },
        overrides: [],
      },
      options: legend(),
      targets: [
        { e: clientWindowStat({ field: 'fields_action_timeouts', window: '5m' }), legend: 'action timeouts ({{service_name}})' },
        { e: wireWindowRate({ field: 'fields_decode_errors', window: '5m' }), legend: 'decode errors ({{fields_client_kind}})', refId: 'B' },
      ],
    }),
  ];

  return {
    uid: 'ion-wire-latency-001',
    title: 'Ion Wire Latency',
    description:
      'How long the Studio wire takes, per client. Server panels time a round trip on the server\'s own clock; client panels show the action latency a person waits through.\n\n**Freshness caveat:** iOS lines arrive through the diagnostic-log pull and may be up to ~30 s behind. Server and desktop lines are current.',
    tags: ['ion', 'wire', 'latency', 'studio', 'transport'],
    schemaVersion: 38,
    version: 1,
    graphTooltip: 1,
    refresh: '30s',
    timeFrom: 'now-1h',
    folder: 'reliability',
    file: 'ion-wire-latency',
    panels,
    annotations: [
      {
        name: 'Server wire windows',
        expr: '{service_name="ion-server", event_name=""} | json | tag="wire-latency" | msg="wire window"',
        iconColor: 'green',
        step: '60s',
        titleFormat: '{{fields_client_kind}} rtt p95={{fields_rtt_p95_ms}}ms dwell p95={{fields_dwell_p95_ms}}ms',
      },
      {
        name: 'Client windows',
        expr: '{service_name=~"ion-(desktop|web|ios)", event_name=""} | json | tag="wire-latency" | msg="client window"',
        iconColor: 'blue',
        step: '60s',
        titleFormat: '{{service_name}} action p95={{fields_action_p95_ms}}ms',
      },
    ],
  };
}
