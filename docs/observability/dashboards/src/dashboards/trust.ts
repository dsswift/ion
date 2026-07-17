// Recipe: Ion Trust (uid ion-trust).
//
// "Can you trust the autonomy dial?" Permission decisions, sandbox blocks, and
// secret containment. All verdict stats are INSTANT panels over $__range so
// they follow the dashboard time picker (ADR-022). Migrated
// semantically-identical; every expression classified.

import type { Dashboard } from '../dashboard.ts';
import { row, text, stat, timeseries, piechart, table, logs } from '../panels.ts';
import { accumulation, instant, stream, telemetry } from '../queries.ts';
import { quantile } from '../queries-latency.ts';
import { groupedKindCount, groupedKindSeries } from '../queries-logs.ts';

const PERM = telemetry('permission.decision');
const fixed = (steps: unknown[]) => ({ mode: 'absolute', steps });
const statOptions = (colorMode: string) => ({
  reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
  orientation: 'auto',
  textMode: 'auto',
  colorMode,
  graphMode: 'none',
});
const line = () => ({
  defaults: { unit: 'short', custom: { drawStyle: 'line', fillOpacity: 10, lineWidth: 2, stacking: { mode: 'none' } } },
  overrides: [],
});
const legendBottom = () => ({
  legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
  tooltip: { mode: 'multi' },
});
const link = (title: string, url: string) => [{ title, url }];

const INTRO =
  '## Can you trust the autonomy dial?\n\nEvery tool call in ask or deny mode passes through one decision function, and every decision is recorded: what was asked, which layer decided (a static rule, a dangerous-command pattern, or the LLM classifier), how long the decision took, and the engine\'s own stated reason. Denials are not failures. A healthy system denies things. What you are watching for is drift: a rising denial rate, the classifier deciding things rules should have caught, or sandbox blocks and secret redactions trending up. Click any decision row to open the session it happened in.\n\n> **No data?** Panels bind to Phase-B telemetry events (`permission.decision`, `sandbox.block`, `secret.containment`). They will be data-empty until the engine emits those events. Query syntax is valid; panels activate automatically once the engine is rebuilt with Tier-4 instrumentation.';

export function trustDashboard(): Dashboard {
  const panels = [
    text(1, { h: 4, w: 24, x: 0, y: 0 }, INTRO),
    row(10, 'Verdict', 4),
    stat({
      id: 2,
      title: 'Autonomy ratio',
      description: 'Fraction of permission checks that resolved to allow. Higher is more autonomous. Watch for sudden drops.',
      gridPos: { h: 4, w: 6, x: 0, y: 5 },
      fieldConfig: {
        defaults: { unit: 'percentunit', decimals: 2, color: { mode: 'thresholds' }, thresholds: fixed([{ color: 'red', value: null }, { color: 'yellow', value: 0.5 }, { color: 'green', value: 0.8 }]), mappings: [], links: link('See denial rate by layer', '/d/ion-trust/ion-trust?viewPanel=5') },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: accumulation(`sum(count_over_time(${PERM} | json | payload_decision="allow" [$__range])) / sum(count_over_time(${PERM} | json [$__range]))`, '$__range') }],
    }),
    stat({
      id: 3,
      title: 'Denials',
      description: 'Count of denied permission checks in the dashboard time range. Denials are not failures — they are the safety mechanism working.',
      gridPos: { h: 4, w: 6, x: 6, y: 5 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'orange' }, thresholds: fixed([]), mappings: [], links: link('See denial rate by layer', '/d/ion-trust/ion-trust?viewPanel=5') },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: accumulation(`sum(count_over_time(${PERM} | json | payload_decision="deny" [$__range]))`, '$__range') }],
    }),
    stat({
      id: 4,
      title: 'Sandbox blocks',
      description: 'Dangerous commands blocked by the sandbox layer.',
      gridPos: { h: 4, w: 6, x: 12, y: 5 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'thresholds' }, thresholds: fixed([{ color: 'green', value: null }, { color: 'yellow', value: 1 }, { color: 'red', value: 10 }]), mappings: [], links: link('See sandbox blocks by reason', '/d/ion-trust/ion-trust?viewPanel=7') },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: accumulation(`sum(count_over_time(${telemetry('sandbox.block')} | json [$__range]))`, '$__range') }],
    }),
    stat({
      id: 5,
      title: 'Secrets contained',
      description: 'Total count of secret matches redacted before they left the engine. Each is one near-miss.',
      gridPos: { h: 4, w: 6, x: 18, y: 5 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'thresholds' }, thresholds: fixed([{ color: 'green', value: null }, { color: 'yellow', value: 1 }, { color: 'red', value: 5 }]), mappings: [], links: link('See secret containment by type', '/d/ion-trust/ion-trust?viewPanel=8') },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: accumulation(`sum(sum_over_time(${telemetry('secret.containment')} | json | unwrap payload_match_count [$__range]))`, '$__range') }],
    }),
    row(20, 'Evidence', 9),
    timeseries({
      id: 6,
      title: 'Denial rate by deciding layer',
      description: 'Which layer is doing the denying: static rules, dangerous-command patterns, or the LLM classifier. Classifier denials are expensive; rules are cheap. Watch for classifier share growing as rules fail to keep up.',
      gridPos: { h: 8, w: 12, x: 0, y: 10 },
      fieldConfig: line(),
      options: legendBottom(),
      targets: [
        {
          e: accumulation(`sum by (payload_deciding_layer) (count_over_time(${PERM} | json | payload_decision="deny" [$__interval]))`, '$__interval'),
          legend: '{{payload_deciding_layer}}',
        },
      ],
    }),
    timeseries({
      id: 7,
      title: 'Decision latency p99: classifier vs rules',
      description: 'The gap between these two lines is the cost of asking a model instead of matching a rule. Classifier cache hits show as sub-millisecond outliers.',
      gridPos: { h: 8, w: 12, x: 12, y: 10 },
      fieldConfig: { defaults: { unit: 'ms', custom: { drawStyle: 'line', fillOpacity: 10, lineWidth: 2, stacking: { mode: 'none' } } }, overrides: [] },
      options: legendBottom(),
      targets: [
        { e: quantile({ q: 0.99, kind: 'permission.decision', field: 'payload_decision_latency_ms', window: '$__interval', filter: ' | payload_deciding_layer="llm_classifier"' }), legend: 'classifier p99', refId: 'A' },
        { e: quantile({ q: 0.99, kind: 'permission.decision', field: 'payload_decision_latency_ms', window: '$__interval', filter: ' | payload_deciding_layer!="llm_classifier"' }), legend: 'rules p99', refId: 'B' },
      ],
    }),
    row(30, 'Drill-down', 26),
    piechart({
      id: 8,
      title: 'Sandbox blocks by reason',
      description: 'Why the sandbox said no. Each slice is a distinct block reason from the dangerous-command pattern set.',
      gridPos: { h: 8, w: 8, x: 0, y: 18 },
      fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
      options: { pieType: 'pie', legend: { displayMode: 'list', placement: 'right', showLegend: true }, tooltip: { mode: 'single' } },
      targets: [{ e: groupedKindCount('sandbox.block', ['payload_reason'], '$__range'), legend: '{{payload_reason}}' }],
    }),
    timeseries({
      id: 9,
      title: 'Secret containment by type',
      description: 'What kinds of secrets the engine caught and suppressed. The type field is the pattern category (api_key, token, password, etc.) — never the secret value itself.',
      gridPos: { h: 8, w: 16, x: 8, y: 18 },
      fieldConfig: { defaults: { unit: 'short', custom: { drawStyle: 'bars', fillOpacity: 60, lineWidth: 1, stacking: { mode: 'normal' } } }, overrides: [] },
      options: legendBottom(),
      targets: [{ e: groupedKindSeries('secret.containment', ['payload_secret_types']), legend: '{{payload_secret_types}}' }],
    }),
    table({
      id: 11,
      title: 'Recent denials with intent reason',
      description: "The engine's own verbatim record of why each tool call was denied. The intent_reason column is the archaeology surface: what the engine understood the agent was trying to do when it said no.",
      gridPos: { h: 10, w: 24, x: 0, y: 27 },
      mode: 'range',
      fieldConfig: {
        defaults: { unit: 'short' },
        overrides: [
          { matcher: { id: 'byName', options: 'context_session_id' }, properties: [{ id: 'links', value: [{ title: 'Open in forensics', url: '/d/ion-forensics/ion-conversation-forensics?var-session=${__value.raw}&${__url_time_range}' }] }] },
        ],
      },
      options: { showHeader: true, footer: { show: false } },
      transformations: [{ id: 'extractFields', options: { source: 'labels', replace: false } }],
      targets: [{ e: stream(`${PERM} | json | payload_decision="deny"`) }],
    }),
    logs({
      id: 12,
      title: 'Live trust stream',
      description: 'Real-time log tail for all trust-surface events: permission decisions, sandbox blocks, and secret containments.',
      gridPos: { h: 10, w: 24, x: 0, y: 37 },
      options: { showTime: true, showLabels: true, showCommonLabels: false, wrapLogMessage: true, prettifyLogMessage: true, enableLogDetails: true, dedupStrategy: 'none', sortOrder: 'Descending' },
      target: { e: stream('{service_name="ion-telemetry", kind=~"permission.decision|sandbox.block|secret.containment"}') },
    }),
  ];

  return {
    uid: 'ion-trust',
    title: 'Ion Trust',
    description: 'Ion trust — can you trust the autonomy dial?',
    tags: ['ion', 'trust'],
    schemaVersion: 39,
    version: 2,
    refresh: '30s',
    timeFrom: 'now-24h',
    folder: 'trust',
    file: 'ion-trust',
    panels,
    templating: [
      { name: 'model', label: 'Model', description: 'Filter by model name. Accepts regex. Default matches all.', type: 'textbox', current: { value: '.+' }, query: '.+', hide: 0 },
    ],
    annotations: [
      { name: 'Extension respawn', type: 'logs', rawQuery: '{service_name="ion-telemetry", kind="extension.respawn"} | json', iconColor: 'red', titleFormat: 'respawn: {{payload_extension}} attempt {{payload_attempt}}/{{payload_budget_max}}' },
    ],
  };
}
