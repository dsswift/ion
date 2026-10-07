// Recipe: Ion Performance (uid ion-performance-001).
//
// How long each operation takes, end to end, from the spans every surface
// emits. Tempo's metrics-generator turns the spans into latency histograms in
// Prometheus (queries-spans.ts), so a percentile here is a percentile of every
// span, not an average of per-minute summaries. The log-sample panels at the
// bottom read the figures that are not spans: the server's event-loop delay
// and the engine's GC pause, allocation rate, and scheduler latency, from the
// 30 s System Metrics sample lines (queries-system-metrics.ts).
//
// Four dropdowns beyond Device and User slice the span metrics by the
// dimensions tempo-config.yaml records: Backend and Model (engine spans),
// Transport (connection.connect), Client kind (server spans). A span that
// does not carry the dimension still matches All.

import type { Dashboard, TemplateVar } from '../dashboard.ts';
import { row, stat, table, timeseries } from '../panels.ts';
import { PROMETHEUS } from '../types.ts';
import { instant, telemetry, windowedStat } from '../queries.ts';
import { quantile } from '../queries-latency.ts';
import { engineSample, serverSample } from '../queries-system-metrics.ts';
import { relayQuantile, spanQuantile, spanQuantileInstant, spanRate, type SpanSelector } from '../queries-spans.ts';

const seconds = (fillOpacity = 10) => ({
  defaults: { unit: 's', custom: { lineWidth: 2, fillOpacity } },
  overrides: [],
});
const unit = (u: string, fillOpacity = 10) => ({
  defaults: { unit: u, custom: { lineWidth: 2, fillOpacity } },
  overrides: [],
});
const legend = () => ({
  tooltip: { mode: 'multi', sort: 'desc' },
  legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
});
const statOpts = {
  reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
  orientation: 'auto',
  textMode: 'auto',
  colorMode: 'value',
  graphMode: 'none',
};
const statSeconds = (thresholds: readonly number[]) => ({
  defaults: {
    unit: 's',
    noValue: 'no spans',
    thresholds: {
      mode: 'absolute',
      steps: [{ color: 'green', value: null }, { color: 'orange', value: thresholds[0] }, { color: 'red', value: thresholds[1] }],
    },
  },
  overrides: [],
});

// The dimension matchers, applied where the span carries the attribute.
const ENGINE_DIMS = ['backend=~"$backend"', 'model=~"$model"'];
const CLIENT_KIND = ['client_kind=~"$client_kind"'];
const TRANSPORT = ['transport=~"$transport"'];

const CLIENTS = ['ion-desktop', 'ion-web', 'ion-ios'];
const ANY = ['.+'];

const p = (q: number, sel: SpanSelector, by: readonly string[]) => spanQuantile({ q, sel, by });

const promVar = (name: string, label: string, description: string): TemplateVar => ({
  name,
  label,
  description,
  type: 'query',
  datasource: PROMETHEUS,
  query: `label_values(traces_spanmetrics_calls_total, ${name})`,
  refresh: 2,
  includeAll: true,
  allValue: '.*',
  multi: true,
  current: { selected: true, text: ['All'], value: ['$__all'] },
  hide: 0,
});

// Cost beside duration, per model, from the run.complete event (LogQL). The
// span-metrics run.execute panel beside it reads the same runs as spans.
const RUN = telemetry('run.complete');
const costPerRunByModel = windowedStat(
  `sum by (payload_model) (sum_over_time(${RUN} | json | unwrap payload_run_cost_usd [$__range]))` +
    ` / sum by (payload_model) (count_over_time(${RUN} | json [$__range]))`,
  '$__range',
);
const runsByModel = instant(`sum by (payload_model) (count_over_time(${RUN} | json [$__range]))`, '$__range');

export function performanceDashboard(): Dashboard {
  const panels = [
    row(1, 'Latency by span', 0),
    timeseries({
      id: 2,
      title: 'Engine spans p95',
      description:
        'p95 of every engine span per step, one line per span name: run.execute, llm.call, llm.attempt, tool.execute, extension.hook_latency, hook.fanout, dispatch.agent, command.dispatch, conversation.load, conversation.persist, context.assemble, compaction, mcp.start, mcp.call, extension.spawn, permission.decide, config.load, provider.probe, session.start, daemon.startup. Backend and Model filter the spans that carry those attributes. Source: traces_spanmetrics_latency_bucket{service="ion-engine"}.',
      gridPos: { h: 9, w: 8, x: 0, y: 1 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [{ e: p(0.95, { span: ANY, service: 'ion-engine', extra: ENGINE_DIMS }, ['span_name']), legend: '{{span_name}}' }],
    }),
    timeseries({
      id: 3,
      title: 'Server spans p95',
      description:
        'p95 of every Ion Studio Server span per step: action.handle, engine.request, engine.send_prompt, snapshot.build, tabs_index.build, thin.first_paint, transcript.patch, body.serve, settled.publish, store.broadcast, git.exec, worktree.*, bench.rebuild, transfer.*, http.request, log.ingest, hello.auth, relay.frame, fleet.deploy, push.ring. Client kind filters the spans that carry it. Source: traces_spanmetrics_latency_bucket{service="ion-server"}.',
      gridPos: { h: 9, w: 8, x: 8, y: 1 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [{ e: p(0.95, { span: ANY, service: 'ion-server', extra: CLIENT_KIND }, ['span_name']), legend: '{{span_name}}' }],
    }),
    timeseries({
      id: 4,
      title: 'Client spans p95',
      description:
        'p95 of every client span per step, one line per service and span name. Desktop: app.launch, window.ready, studio.first_paint, store.hydrate, connection.connect, body.load, transcript.apply, prompt.send, prompt.visible, terminal.echo. iOS: app.launch, connection.connect, pairing.complete, snapshot.apply, transcript.apply, prompt.send, prompt.visible, push.open. A browser Studio tab is ion-web. Source: traces_spanmetrics_latency_bucket{service=~"ion-desktop|ion-web|ion-ios"}.',
      gridPos: { h: 9, w: 8, x: 16, y: 1 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [{ e: p(0.95, { span: ANY, service: CLIENTS }, ['service', 'span_name']), legend: '{{service}} {{span_name}}' }],
    }),
    table({
      id: 5,
      title: 'p50 / p95 / p99 per span and service',
      description:
        'Every span name Tempo has seen in the range, by service, with its p50, p95, and p99 over the whole range. Sort by p99 to find the slowest operation. Seconds. Source: traces_spanmetrics_latency_bucket.',
      gridPos: { h: 10, w: 24, x: 0, y: 10 },
      mode: 'instant',
      fieldConfig: {
        defaults: { unit: 's', decimals: 3, custom: { align: 'auto', filterable: true } },
        overrides: [
          { matcher: { id: 'byName', options: 'service' }, properties: [{ id: 'custom.width', value: 140 }] },
          { matcher: { id: 'byName', options: 'span_name' }, properties: [{ id: 'displayName', value: 'span' }, { id: 'custom.width', value: 240 }] },
          { matcher: { id: 'byName', options: 'Value #A' }, properties: [{ id: 'displayName', value: 'p50' }] },
          { matcher: { id: 'byName', options: 'Value #B' }, properties: [{ id: 'displayName', value: 'p95' }] },
          { matcher: { id: 'byName', options: 'Value #C' }, properties: [{ id: 'displayName', value: 'p99' }] },
        ],
      },
      options: { showHeader: true, sortBy: [{ displayName: 'p99', desc: true }], footer: { show: false } },
      transformations: [{ id: 'merge', options: {} }, { id: 'organize', options: { excludeByName: { Time: true }, indexByName: {}, renameByName: {} } }],
      targets: [
        { e: spanQuantileInstant({ q: 0.5, sel: { span: ANY }, by: ['service', 'span_name'] }) },
        { e: spanQuantileInstant({ q: 0.95, sel: { span: ANY }, by: ['service', 'span_name'] }), refId: 'B' },
        { e: spanQuantileInstant({ q: 0.99, sel: { span: ANY }, by: ['service', 'span_name'] }), refId: 'C' },
      ],
    }),

    row(6, 'Run duration and cost', 20),
    timeseries({
      id: 7,
      title: 'run.execute p50 / p95 by model',
      description:
        'How long an engine run takes from start to exit, per model, from the run.execute span. The alert "Ion run p95 over 120 s" reads the ungrouped p95. Source: traces_spanmetrics_latency_bucket{span_name="run.execute"}.',
      gridPos: { h: 9, w: 8, x: 0, y: 21 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [
        { e: p(0.5, { span: 'run.execute', service: 'ion-engine', extra: ENGINE_DIMS }, ['model']), legend: 'p50 {{model}}' },
        { e: p(0.95, { span: 'run.execute', service: 'ion-engine', extra: ENGINE_DIMS }, ['model']), legend: 'p95 {{model}}', refId: 'B' },
      ],
    }),
    timeseries({
      id: 8,
      title: 'LLM call, attempt, and tool p95',
      description:
        'Inside a run: llm.call is one model turn including retries, llm.attempt one request to the provider, tool.execute one tool call, provider.probe one provider reachability probe. A gap between llm.call and llm.attempt is retry time. Source: traces_spanmetrics_latency_bucket{service="ion-engine"}.',
      gridPos: { h: 9, w: 8, x: 8, y: 21 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [
        {
          e: p(0.95, { span: ['llm.call', 'llm.attempt', 'tool.execute', 'provider.probe'], service: 'ion-engine', extra: ENGINE_DIMS }, ['span_name']),
          legend: '{{span_name}}',
        },
      ],
    }),
    table({
      id: 9,
      title: 'Cost and duration per run, by model',
      description:
        'One row per model over the range: runs, average cost per run (run_cost_usd, this run only, excluding dispatched sub-agents), and the p95 run duration the engine reported on run.complete. Reads the telemetry event, so it needs telemetry enabled; the span panel beside it reads the same runs as spans. Source: {event_name="run.complete"}.',
      gridPos: { h: 9, w: 8, x: 16, y: 21 },
      mode: 'instant',
      fieldConfig: {
        defaults: { unit: 'short', custom: { align: 'auto', filterable: true } },
        overrides: [
          { matcher: { id: 'byName', options: 'payload_model' }, properties: [{ id: 'displayName', value: 'model' }] },
          { matcher: { id: 'byName', options: 'Value #A' }, properties: [{ id: 'displayName', value: 'runs' }] },
          { matcher: { id: 'byName', options: 'Value #B' }, properties: [{ id: 'displayName', value: 'cost / run' }, { id: 'unit', value: 'currencyUSD' }, { id: 'decimals', value: 4 }] },
          { matcher: { id: 'byName', options: 'Value #C' }, properties: [{ id: 'displayName', value: 'duration p95' }, { id: 'unit', value: 'ms' }] },
        ],
      },
      options: { showHeader: true, sortBy: [{ displayName: 'cost / run', desc: true }], footer: { show: false } },
      transformations: [{ id: 'merge', options: {} }, { id: 'organize', options: { excludeByName: { Time: true }, indexByName: {}, renameByName: {} } }],
      targets: [
        { e: runsByModel },
        { e: costPerRunByModel, refId: 'B' },
        { e: quantile({ q: 0.95, kind: 'run.complete', field: 'payload_duration_ms', window: '$__range', by: ['payload_model'] }), refId: 'C' },
      ],
    }),

    row(10, 'Cold starts', 30),
    stat({
      id: 11,
      title: 'Engine daemon startup p95',
      description: 'daemon.startup: the engine process from start to the socket accepting clients, p95 over the range.',
      gridPos: { h: 4, w: 6, x: 0, y: 31 },
      fieldConfig: statSeconds([2, 5]),
      options: statOpts,
      targets: [{ e: spanQuantileInstant({ q: 0.95, sel: { span: 'daemon.startup', service: 'ion-engine' } }) }],
    }),
    stat({
      id: 12,
      title: 'Studio app launch p95',
      description: 'app.launch on the desktop: Electron start to the first Studio window ready, p95 over the range.',
      gridPos: { h: 4, w: 6, x: 6, y: 31 },
      fieldConfig: statSeconds([3, 8]),
      options: statOpts,
      targets: [{ e: spanQuantileInstant({ q: 0.95, sel: { span: 'app.launch', service: 'ion-desktop' } }) }],
    }),
    stat({
      id: 13,
      title: 'iOS app launch p95',
      description: 'app.launch on the phone: process start to the first screen, p95 over the range. Phone spans ride the server\'s diagnostic-log pull, so this can be up to ~30 s behind.',
      gridPos: { h: 4, w: 6, x: 12, y: 31 },
      fieldConfig: statSeconds([2, 5]),
      options: statOpts,
      targets: [{ e: spanQuantileInstant({ q: 0.95, sel: { span: 'app.launch', service: 'ion-ios' } }) }],
    }),
    stat({
      id: 14,
      title: 'Extension spawn p95',
      description: 'extension.spawn: the engine starting an extension subprocess to its init handshake, p95 over the range.',
      gridPos: { h: 4, w: 6, x: 18, y: 31 },
      fieldConfig: statSeconds([1, 3]),
      options: statOpts,
      targets: [{ e: spanQuantileInstant({ q: 0.95, sel: { span: 'extension.spawn', service: 'ion-engine' } }) }],
    }),
    timeseries({
      id: 15,
      title: 'Cold starts over time (p95)',
      description:
        'The start-up spans per step, one line per service and span: daemon.startup and session.start (engine), extension.spawn and mcp.start (engine), app.launch, window.ready and studio.first_paint (desktop), app.launch and pairing.complete (iOS). There is no Ion Studio Server start-up span; the server\'s first hello.auth marks its readiness.',
      gridPos: { h: 8, w: 24, x: 0, y: 35 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [
        {
          e: p(0.95, { span: ['daemon.startup', 'session.start', 'extension.spawn', 'mcp.start', 'app.launch', 'window.ready', 'studio.first_paint', 'pairing.complete'] }, ['service', 'span_name']),
          legend: '{{service}} {{span_name}}',
        },
      ],
    }),

    row(16, 'Store actions and engine requests', 43),
    timeseries({
      id: 17,
      title: 'action.handle p95 by action',
      description:
        'The server\'s own time on one Studio store action, receipt to result sent, per action name (the `action` attribute). Client kind filters by the connection that sent it. The wire is not in this number; Ion Wire Latency has the client-felt figure. Source: traces_spanmetrics_latency_bucket{span_name="action.handle"}.',
      gridPos: { h: 9, w: 12, x: 0, y: 44 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [{ e: p(0.95, { span: 'action.handle', service: 'ion-server', extra: CLIENT_KIND }, ['action']), legend: '{{action}}' }],
    }),
    timeseries({
      id: 18,
      title: 'Store actions per second by surface',
      description: 'How many actions each Studio surface (the `surface` attribute) sends per second. Source: traces_spanmetrics_calls_total{span_name="action.handle"}.',
      gridPos: { h: 9, w: 12, x: 12, y: 44 },
      fieldConfig: unit('reqps', 20),
      options: legend(),
      targets: [{ e: spanRate({ sel: { span: 'action.handle', service: 'ion-server', extra: CLIENT_KIND }, by: ['surface'] }), legend: '{{surface}}' }],
    }),
    timeseries({
      id: 19,
      title: 'engine.request p95 by command',
      description: 'A server request to the engine, per client command (the `command` attribute), from send to the engine\'s answer. Source: traces_spanmetrics_latency_bucket{span_name="engine.request"}.',
      gridPos: { h: 9, w: 12, x: 0, y: 53 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [{ e: p(0.95, { span: 'engine.request', service: 'ion-server' }, ['command']), legend: '{{command}}' }],
    }),
    timeseries({
      id: 20,
      title: 'Prompt hand-off and engine command dispatch p95',
      description:
        'action.handle with action=submit (server, the prompt case) and engine.send_prompt (server): a prompt from receipt to the engine accepting it. command.dispatch (engine): one client command from receipt to its result, per command. Source: traces_spanmetrics_latency_bucket.',
      gridPos: { h: 9, w: 12, x: 12, y: 53 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [
        { e: p(0.95, { span: 'action.handle', service: 'ion-server', extra: ['action="submit"'] }), legend: 'action.handle submit' },
        { e: p(0.95, { span: 'engine.send_prompt', service: 'ion-server' }), legend: 'engine.send_prompt', refId: 'C' },
        { e: p(0.95, { span: 'command.dispatch', service: 'ion-engine' }, ['command']), legend: 'command.dispatch {{command}}', refId: 'B' },
      ],
    }),

    row(21, 'Snapshot, patch, and publish', 62),
    timeseries({
      id: 22,
      title: 'Server build and publish spans p95',
      description:
        'snapshot.build and tabs_index.build (what a connecting client receives), thin.first_paint (the phone\'s first screen), transcript.patch (one transcript delta), settled.publish and store.broadcast (fan-out to every connection). Source: traces_spanmetrics_latency_bucket{service="ion-server"}.',
      gridPos: { h: 9, w: 12, x: 0, y: 63 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [
        {
          e: p(0.95, { span: ['snapshot.build', 'tabs_index.build', 'thin.first_paint', 'transcript.patch', 'settled.publish', 'store.broadcast'], service: 'ion-server' }, ['span_name']),
          legend: '{{span_name}}',
        },
      ],
    }),
    timeseries({
      id: 23,
      title: 'Body serve and conversation persistence p95',
      description:
        'body.serve (server): one conversation body served to a client. conversation.load, conversation.persist, context.assemble, compaction (engine): reading and writing the conversation tree and building the model context. Source: traces_spanmetrics_latency_bucket.',
      gridPos: { h: 9, w: 12, x: 12, y: 63 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [
        { e: p(0.95, { span: 'body.serve', service: 'ion-server' }, ['span_name']), legend: '{{span_name}}' },
        { e: p(0.95, { span: ['conversation.load', 'conversation.persist', 'context.assemble', 'compaction'], service: 'ion-engine' }, ['span_name']), legend: '{{span_name}}', refId: 'B' },
      ],
    }),

    row(24, 'Render and hydrate', 72),
    timeseries({
      id: 25,
      title: 'Client render and hydrate spans p95',
      description:
        'store.hydrate (desktop: the mirror store filled from the first snapshot), snapshot.apply (iOS), transcript.apply (both: one transcript delta rendered), body.load (desktop: a conversation body fetched and shown), connection.connect (both; Transport filters the desktop\'s). Source: traces_spanmetrics_latency_bucket{service=~"ion-desktop|ion-web|ion-ios"}.',
      gridPos: { h: 9, w: 12, x: 0, y: 73 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [
        {
          e: p(0.95, { span: ['store.hydrate', 'snapshot.apply', 'transcript.apply', 'body.load', 'connection.connect'], service: CLIENTS, extra: TRANSPORT }, ['service', 'span_name']),
          legend: '{{service}} {{span_name}}',
        },
      ],
    }),
    timeseries({
      id: 26,
      title: 'Prompt send and prompt visible p95',
      description:
        'prompt.send: the operator submits until the server answers. prompt.visible: the same submit until the first token of the answer is on screen, the number a person feels. Per client service. Source: traces_spanmetrics_latency_bucket{span_name=~"prompt.send|prompt.visible"}.',
      gridPos: { h: 9, w: 12, x: 12, y: 73 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [{ e: p(0.95, { span: ['prompt.send', 'prompt.visible'], service: CLIENTS }, ['service', 'span_name']), legend: '{{service}} {{span_name}}' }],
    }),

    row(27, 'Relay', 82),
    timeseries({
      id: 28,
      title: 'relay.forward p95 by direction (span metrics)',
      description: 'The relay forwarding one frame, receive to the write to the peer, per direction, from its relay.forward span. Source: traces_spanmetrics_latency_bucket{service="ion-relay"}.',
      gridPos: { h: 9, w: 8, x: 0, y: 83 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [{ e: p(0.95, { span: 'relay.forward', service: 'ion-relay' }, ['direction']), legend: '{{direction}}' }],
    }),
    timeseries({
      id: 29,
      title: 'Relay forward p50 / p95 by direction (relay metrics)',
      description: 'The same forward, from the relay\'s own relay_forward_seconds histogram scraped by Prometheus. Agreement with the span panel beside it is the check that both paths see every frame.',
      gridPos: { h: 9, w: 8, x: 8, y: 83 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [
        { e: relayQuantile({ q: 0.5, metric: 'relay_forward_seconds', by: ['direction'] }), legend: 'p50 {{direction}}' },
        { e: relayQuantile({ q: 0.95, metric: 'relay_forward_seconds', by: ['direction'] }), legend: 'p95 {{direction}}', refId: 'B' },
      ],
    }),
    timeseries({
      id: 30,
      title: 'Relay ping round trip p50 / p95',
      description: 'The relay\'s WebSocket ping to each peer and back, on the relay\'s clock. Source: relay_ping_rtt_seconds.',
      gridPos: { h: 9, w: 8, x: 16, y: 83 },
      fieldConfig: seconds(),
      options: legend(),
      targets: [
        { e: relayQuantile({ q: 0.5, metric: 'relay_ping_rtt_seconds' }), legend: 'p50' },
        { e: relayQuantile({ q: 0.95, metric: 'relay_ping_rtt_seconds' }), legend: 'p95', refId: 'B' },
      ],
    }),

    row(31, 'Runtime: event loop and garbage collector', 92),
    timeseries({
      id: 32,
      title: 'Server event-loop delay (per-sample p50 / p99)',
      description:
        'How late the Ion Studio Server\'s event loop ran its timers, per device: the p50 and p99 within each 30 s sample, averaged over 5 m. A p99 above 200 ms for 5 minutes fires "Ion server event loop p99 over 200 ms". Source: server.jsonl tag=system-metrics fields.server_event_loop_p50_ms / server_event_loop_p99_ms.',
      gridPos: { h: 9, w: 12, x: 0, y: 93 },
      fieldConfig: unit('ms'),
      options: legend(),
      targets: [
        { e: serverSample('fields_server_event_loop_p50_ms'), legend: 'p50 {{host_name}}' },
        { e: serverSample('fields_server_event_loop_p99_ms'), legend: 'p99 {{host_name}}', refId: 'B' },
      ],
    }),
    timeseries({
      id: 33,
      title: 'Engine GC pause p99 and scheduler latency p99',
      description:
        'The Go runtime\'s stop-the-world pause and goroutine scheduling latency inside the engine, per device: the p99 within each 30 s sample, averaged over 5 m. Source: engine.jsonl tag=sysmetrics fields.gc_pause_p99_ms / sched_latency_p99_ms.',
      gridPos: { h: 9, w: 12, x: 12, y: 93 },
      fieldConfig: unit('ms'),
      options: legend(),
      targets: [
        { e: engineSample('fields_gc_pause_p99_ms'), legend: 'GC pause {{host_name}}' },
        { e: engineSample('fields_sched_latency_p99_ms'), legend: 'scheduler {{host_name}}', refId: 'B' },
      ],
    }),
    timeseries({
      id: 34,
      title: 'Engine allocation rate',
      description: 'Bytes the engine allocated per second since the previous sample, per device. A climbing rate with a flat heap is churn the collector is paying for. Source: engine.jsonl tag=sysmetrics fields.alloc_rate_bytes_per_s.',
      gridPos: { h: 8, w: 24, x: 0, y: 102 },
      fieldConfig: unit('Bps'),
      options: legend(),
      targets: [{ e: engineSample('fields_alloc_rate_bytes_per_s'), legend: '{{host_name}}' }],
    }),
  ];

  return {
    uid: 'ion-performance-001',
    title: 'Ion Performance',
    description:
      'How long each operation takes, end to end, from the spans every surface emits: percentiles per span name and service from Tempo\'s span metrics in Prometheus, run duration beside cost, cold starts, store actions, snapshot and patch builds, client render and hydrate, the relay, and the server event loop and engine GC from the System Metrics sample lines. Phone spans ride the server\'s diagnostic-log pull and can be up to ~30 s behind.',
    tags: ['ion', 'performance', 'latency', 'spans', 'tempo'],
    schemaVersion: 38,
    version: 1,
    graphTooltip: 1,
    refresh: '30s',
    timeFrom: 'now-1h',
    folder: 'reliability',
    file: 'ion-performance',
    panels,
    templating: [
      promVar('backend', 'Backend', 'The run\'s backend (`backend` span attribute): the engine\'s own model loop, or a delegated CLI. Filters engine spans; All keeps spans without the attribute.'),
      promVar('model', 'Model', 'The model a run or call used (`model` span attribute). Filters engine spans; All keeps spans without the attribute.'),
      promVar('transport', 'Transport', 'How Studio reached the server (`transport` on connection.connect). Filters client spans; All keeps spans without the attribute.'),
      promVar('client_kind', 'Client kind', 'The connection kind the server saw (`client_kind` on server spans): desktop, web, or ios. Filters server spans; All keeps spans without the attribute.'),
    ],
    annotations: [],
  };
}
