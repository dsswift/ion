// Recipe: Ion Quality (uid ion-quality).
//
// "Is the agent actually doing good work?" Migrated semantically-identical.

import type { Dashboard } from '../dashboard.ts';
import { row, text, stat, timeseries, heatmap, table } from '../panels.ts';
import { instant, stream, telemetry } from '../queries.ts';
import { quantileInstant, quantile } from '../queries-latency.ts';
import { groupedKindSeries } from '../queries-logs.ts';

const FAIL = telemetry('tool.failure');
const EXEC = telemetry('tool.execute');
const fixed = (steps: unknown[]) => ({ mode: 'absolute', steps });
const statOptions = () => ({
  reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
  orientation: 'auto',
  textMode: 'auto',
  colorMode: 'background',
  graphMode: 'none',
});
const line = (unit: string, stacking = 'none') => ({
  defaults: { unit, custom: { drawStyle: 'line', fillOpacity: 10, lineWidth: 2, stacking: { mode: stacking } } },
  overrides: [],
});
const legendBottom = (multi = true) => ({
  legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
  tooltip: { mode: multi ? 'multi' : 'single' },
});
const link = (title: string, url: string) => [{ title, url }];
const sessionLink = () => ({
  matcher: { id: 'byName', options: 'context_session_id' },
  properties: [{ id: 'links', value: [{ title: 'Open in forensics', url: '/d/ion-forensics/ion-conversation-forensics?var-session=${__value.raw}&${__url_time_range}' }] }],
});

// Same forensics link, but bound to a renamed column. The organize rename runs
// before field overrides, so a table that renames context_session_id must point
// its link override at the new column name or the link silently vanishes.
const sessionLinkNamed = (col: string) => ({
  matcher: { id: 'byName', options: col },
  properties: [{ id: 'links', value: [{ title: 'Open in forensics', url: '/d/ion-forensics/ion-conversation-forensics?var-session=${__value.raw}&${__url_time_range}' }] }],
});

const INTRO =
  '## Is the agent actually doing good work?\n\nCost tells you what a run spent. This pack tells you whether the spending was productive: how often tools fail and why, whether the same tool keeps failing in a loop (thrash), how turns end, and whether extension hooks are dragging on the hot path. A rising thrash index is the earliest signal a session has gone sideways. Every row links to the conversation it came from.\n\n> **No data on tool.failure / extension.hook_latency panels?** Those bind to Phase-B Tier-4 telemetry events. The `tool.execute` and `llm.call` panels bind to shipped Tier-1 events and will populate normally. All query syntax is valid.';

export function qualityDashboard(): Dashboard {
  const panels = [
    text(1, { h: 4, w: 24, x: 0, y: 0 }, INTRO),
    row(10, 'Verdict', 4),
    stat({
      id: 2,
      title: 'Tool failures',
      description: 'Total tool execution failures in the dashboard time range across all sessions.',
      gridPos: { h: 4, w: 6, x: 0, y: 5 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'thresholds' }, thresholds: fixed([{ color: 'green', value: null }, { color: 'yellow', value: 5 }, { color: 'red', value: 20 }]), mappings: [], links: link('See failure taxonomy', '/d/ion-quality/ion-quality?viewPanel=6') },
        overrides: [],
      },
      options: statOptions(),
      targets: [{ e: instant(`sum(count_over_time(${FAIL} | json [$__range]))`, '$__range') }],
    }),
    stat({
      id: 3,
      title: 'Tool failure rate',
      description: 'Failures as a fraction of total tool executions. Numerator: tool.failure (Tier-4). Denominator: tool.execute (shipped Tier-1).',
      gridPos: { h: 4, w: 6, x: 6, y: 5 },
      fieldConfig: {
        defaults: { unit: 'percentunit', decimals: 2, color: { mode: 'thresholds' }, thresholds: fixed([{ color: 'green', value: null }, { color: 'yellow', value: 0.05 }, { color: 'red', value: 0.15 }]), mappings: [] },
        overrides: [],
      },
      options: statOptions(),
      targets: [{ e: instant(`sum(count_over_time(${FAIL} | json [$__range])) / sum(count_over_time(${EXEC} [$__range]))`, '$__range') }],
    }),
    stat({
      id: 4,
      title: 'Sessions thrashing now (5m)',
      description: 'Sessions where the same tool has failed 3 or more times in the last 5 minutes. The thrash definition from the instrumentation spec: same tool, same session, 3+ failures in a 5-minute window.',
      gridPos: { h: 4, w: 6, x: 12, y: 5 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'thresholds' }, thresholds: fixed([{ color: 'green', value: null }, { color: 'red', value: 1 }]), mappings: [], links: link('See thrash leaderboard', '/d/ion-quality/ion-quality?viewPanel=11') },
        overrides: [],
      },
      options: statOptions(),
      targets: [{ e: instant(`count(sum by (context_session_id, payload_tool) (count_over_time(${FAIL} | json [5m])) > 3)`, '5m') }],
    }),
    stat({
      id: 5,
      title: 'Hook latency p99',
      description: '99th-percentile extension hook latency across all hooks and extensions in the dashboard time range. High values mean extensions are slowing the agent\'s hot path.',
      gridPos: { h: 4, w: 6, x: 18, y: 5 },
      fieldConfig: {
        defaults: { unit: 'ms', color: { mode: 'thresholds' }, thresholds: fixed([{ color: 'green', value: null }, { color: 'yellow', value: 100 }, { color: 'red', value: 500 }]), mappings: [], links: link('See hook latency by extension', '/d/ion-quality/ion-quality?viewPanel=10') },
        overrides: [],
      },
      options: statOptions(),
      targets: [{ e: quantileInstant({ q: 0.99, kind: 'extension.hook_latency', field: 'payload_latency_ms', window: '$__range' }) }],
    }),
    row(20, 'Evidence', 9),
    timeseries({
      id: 6,
      title: 'Failure taxonomy over time',
      description: 'Tool failures broken down by category. Categories are the error branches in the tool execution path: permission_denied, not_found, timeout, parse_error, runtime_error, network_error, unknown.',
      gridPos: { h: 8, w: 12, x: 0, y: 10 },
      fieldConfig: line('short'),
      options: legendBottom(true),
      targets: [{ e: groupedKindSeries('tool.failure', ['payload_failure_category']), legend: '{{payload_failure_category}}' }],
    }),
    timeseries({
      id: 7,
      title: 'Stop-reason mix per turn',
      description: 'How LLM turns end: end_turn, tool_use, max_tokens, stop_sequence. A spike in max_tokens means the model is hitting its output limit. Shipped structured metadata, no parser required.',
      gridPos: { h: 8, w: 12, x: 12, y: 10 },
      fieldConfig: line('short', 'normal'),
      options: legendBottom(true),
      targets: [{ e: groupedKindSeries('llm.call', ['payload_stop_reason']), legend: '{{payload_stop_reason}}' }],
    }),
    timeseries({
      id: 8,
      title: 'Tool duration p95 by tool',
      description: '95th-percentile execution time per tool. Shipped Tier-1 structured metadata; no JSON parser required. Outliers here identify the tools slowing individual turns.',
      gridPos: { h: 8, w: 12, x: 0, y: 18 },
      fieldConfig: line('ms'),
      options: legendBottom(true),
      targets: [{ e: quantile({ q: 0.95, kind: 'tool.execute', field: 'payload_duration_ms', window: '$__interval', by: ['tool'] }), legend: '{{tool}}' }],
    }),
    heatmap({
      id: 9,
      title: 'Per-tool failure heat',
      description: 'Which tools are failing and with which category. Each cell is count of failures for that tool/category combination in the time bucket.',
      gridPos: { h: 8, w: 12, x: 12, y: 18 },
      fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
      options: {
        calculate: false,
        cellGap: 1,
        color: { exponent: 0.5, fill: 'dark-orange', mode: 'scheme', scale: 'exponential', scheme: 'Oranges', steps: 64 },
        tooltip: { mode: 'single', showColorScale: false, yHistogram: false },
        yAxis: { unit: 'short' },
      },
      targets: [{ e: groupedKindSeries('tool.failure', ['payload_tool', 'payload_failure_category']), legend: '{{payload_tool}} / {{payload_failure_category}}' }],
    }),
    timeseries({
      id: 10,
      title: 'Hook latency p99 by extension and hook',
      description: 'Which extension and which hook are the slowest. Hooks on the synchronous path block the turn; watch for any hook consistently above 100ms.',
      gridPos: { h: 8, w: 24, x: 0, y: 26 },
      fieldConfig: line('ms'),
      options: legendBottom(true),
      targets: [{ e: quantile({ q: 0.99, kind: 'extension.hook_latency', field: 'payload_latency_ms', window: '$__interval', by: ['payload_extension', 'payload_hook'] }), legend: '{{payload_extension}} / {{payload_hook}}' }],
    }),
    row(30, 'Drill-down', 34),
    table({
      id: 11,
      title: 'Thrash leaderboard (range)',
      description: 'Sessions ranked by same-tool repeat failures. The session with the highest count for a given tool is the one most likely to be stuck. Click a session to open forensics.',
      gridPos: { h: 10, w: 12, x: 0, y: 35 },
      mode: 'instant',
      fieldConfig: { defaults: { unit: 'short' }, overrides: [sessionLinkNamed('Session')] },
      // Human headers: an instant table renders one column per label plus a bare
      // "Value". Rename them so the table reads Session / Tool / Repeat failures.
      options: { showHeader: true, sortBy: [{ displayName: 'Repeat failures', desc: true }], footer: { show: false } },
      transformations: [
        { id: 'organize', options: { renameByName: { context_session_id: 'Session', payload_tool: 'Tool', Value: 'Repeat failures' } } },
      ],
      targets: [{ e: instant(`sum by (context_session_id, payload_tool) (count_over_time(${FAIL} | json [$__range]))`, '$__range'), legend: '{{context_session_id}} / {{payload_tool}}' }],
    }),
    table({
      id: 12,
      title: 'Recent failures with error preview',
      description: 'The most recent tool failures with a preview of the error message. Use this to identify the root cause before opening the full session trace.',
      gridPos: { h: 10, w: 12, x: 12, y: 35 },
      mode: 'range',
      fieldConfig: { defaults: { unit: 'short' }, overrides: [sessionLink()] },
      options: { showHeader: true, footer: { show: false } },
      transformations: [{ id: 'extractFields', options: { source: 'labels', replace: false } }],
      targets: [{ e: stream(`${FAIL} | json`) }],
    }),
  ];

  return {
    uid: 'ion-quality',
    title: 'Ion Quality',
    description: 'Ion quality — is the agent actually doing good work?',
    tags: ['ion', 'quality'],
    schemaVersion: 39,
    version: 3,
    refresh: '30s',
    timeFrom: 'now-24h',
    folder: 'quality',
    file: 'ion-quality',
    panels,
    templating: [
      { name: 'model', label: 'Model', description: 'Filter by model name. Accepts regex. Default matches all.', type: 'textbox', current: { value: '.+' }, query: '.+', hide: 0 },
    ],
    annotations: [
      { name: 'Compaction', type: 'logs', rawQuery: '{service_name="ion-telemetry", kind="compaction"} | json', iconColor: 'blue', titleFormat: 'compaction: {{payload_trigger}} reclaimed {{payload_tokens_reclaimed}} tokens' },
      { name: 'Extension respawn', type: 'logs', rawQuery: '{service_name="ion-telemetry", kind="extension.respawn"} | json', iconColor: 'red', titleFormat: 'respawn: {{payload_extension}} attempt {{payload_attempt}}/{{payload_budget_max}}' },
    ],
  };
}
