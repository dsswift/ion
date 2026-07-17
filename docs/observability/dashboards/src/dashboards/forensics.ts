// Recipe: Ion Conversation Forensics (uid ion-forensics).
//
// "What happened in this conversation?" Session leaderboard (anomaly score) +
// per-session drill-down, filtered by the $session textbox variable. Migrated
// semantically-identical.

import type { Dashboard } from '../dashboard.ts';
import { text, timeseries, table, stat, traces, logs } from '../panels.ts';
import { instant, stream, telemetry } from '../queries.ts';
import { quantile, latestMax } from '../queries-latency.ts';

const RUN = telemetry('run.complete');
const legendBottom = (multi = false) => ({
  legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
  tooltip: { mode: multi ? 'multi' : 'single' },
});

const INTRO =
  '## One conversation, end to end\n\nPick a session from the leaderboard (it ranks recent conversations by failures, denials, provider trouble, context pressure, and cost) or arrive here from any other dashboard\'s session link. Everything below is filtered to that one conversation: how full its context window got and when compaction stepped in, which tools failed and why, what every turn cost in time, and the full sub-agent dispatch tree. Read it top to bottom and you can reconstruct the session without opening a debugger.\n\n> Set `$session` by clicking a row in the leaderboard, or enter a session ID in the variable box above. Panels that require the `$session` variable will be empty until a session is selected.';

// Leaderboard scoring targets — instant grouped aggregations over $__range.
const lb = (expr: string) => instant(expr, '$__range');

export function forensicsDashboard(): Dashboard {
  const panels = [
    text(1, { h: 4, w: 24, x: 0, y: 0 }, INTRO),
    table({
      id: 2,
      title: 'Session leaderboard (anomaly score)',
      description:
        'Recent conversations ranked by a weighted anomaly score: tool failures (3x), denials (2x), provider retries+stalls (2x), compactions (1x), context pressure (0.05x per point), cost (10x per USD). The spine is run.complete, so every conversation in the window appears — clean conversations (zero anomaly events) show score 0 via the outer join. Click a conversation ID to filter all panels below to that conversation.',
      gridPos: { h: 12, w: 24, x: 0, y: 4 },
      mode: 'instant',
      fieldConfig: {
        defaults: { unit: 'short' },
        overrides: [
          {
            matcher: { id: 'byName', options: 'context_conversation_id' },
            properties: [
              { id: 'links', value: [{ title: 'Filter to this session', url: '/d/ion-forensics/ion-conversation-forensics?var-session=${__value.raw}&${__url_time_range}' }] },
            ],
          },
        ],
      },
      options: { showHeader: true, sortBy: [{ displayName: 'score', desc: true }], footer: { show: false } },
      transformations: [
        { id: 'joinByField', options: { byField: 'context_conversation_id', mode: 'outerTabular' } },
        { id: 'calculateField', options: { alias: 'score', mode: 'reduceRow', reduce: { reducer: 'sum' }, binary: { left: 'Value #A', right: 'Value #B', reducer: 'sum' } } },
        {
          id: 'organize',
          options: {
            excludeByName: { Time: true, 'Time 1': true, 'Time 2': true, 'Time 3': true, 'Time 4': true, 'Time 5': true, 'Time 6': true, 'Time 7': true, 'Value #A': true },
            renameByName: {
              'Value #A': 'conversations',
              'Value #B': 'tool failures ×3',
              'Value #C': 'denials ×2',
              'Value #D': 'provider trouble ×2',
              'Value #E': 'compactions',
              'Value #F': 'context pressure ×0.05',
              'Value #G': 'cost USD ×10',
            },
          },
        },
      ],
      targets: [
        { e: lb(`sum by (context_conversation_id) (count_over_time(${RUN} | json [$__range]))`), legend: 'runs {{context_conversation_id}}', refId: 'A' },
        { e: lb(`sum by (context_conversation_id) (count_over_time(${telemetry('tool.failure')} | json [$__range])) * 3`), legend: 'tool_failures_x3 {{context_conversation_id}}', refId: 'B' },
        { e: lb(`sum by (context_conversation_id) (count_over_time(${telemetry('permission.decision')} | json | context_conversation_id != "" | payload_decision="deny" [$__range])) * 2`), legend: 'denials_x2 {{context_conversation_id}}', refId: 'C' },
        { e: lb(`sum by (context_conversation_id) (count_over_time({service_name="ion-telemetry", kind=~"provider.retry|provider.stall"} | json [$__range])) * 2`), legend: 'provider_trouble_x2 {{context_conversation_id}}', refId: 'D' },
        { e: lb(`sum by (context_conversation_id) (count_over_time(${telemetry('compaction')} | json [$__range]))`), legend: 'compactions {{context_conversation_id}}', refId: 'E' },
        { e: lb(`max by (context_conversation_id) (max_over_time(${telemetry('context.pressure')} | json | unwrap payload_percent [$__range])) * 0.05`), legend: 'context_pressure_x0.05 {{context_conversation_id}}', refId: 'F' },
        { e: lb(`sum by (context_conversation_id) (sum_over_time(${RUN} | json | unwrap payload_run_cost_usd [$__range])) * 10`), legend: 'cost_usd_x10 {{context_conversation_id}}', refId: 'G' },
      ],
    }),
    timeseries({
      id: 3,
      title: 'Context pressure over turns',
      description:
        'How full the context window was at each pressure sample. Compaction events are annotated on the timeline. The threshold marker is derived from payload_compact_limit when available.',
      gridPos: { h: 8, w: 16, x: 0, y: 16 },
      fieldConfig: {
        defaults: {
          unit: 'percentunit',
          min: 0,
          max: 1,
          custom: { drawStyle: 'line', fillOpacity: 20, lineWidth: 2, stacking: { mode: 'none' } },
          thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'yellow', value: 0.6 }, { color: 'red', value: 0.8 }] },
        },
        overrides: [],
      },
      options: legendBottom(false),
      targets: [{ e: latestMax({ kind: 'context.pressure', field: 'payload_percent', window: '$__interval', filter: ' | context_conversation_id="$session"' }), legend: 'context pressure %' }],
    }),
    stat({
      id: 13,
      title: 'Session summary',
      description:
        'Cost, turns, and tokens for the selected conversation. run.complete carries context.conversation_id in its telemetry context block — the durable conversation-file ID, consistent across all event types — so these totals are correctly filtered to $session.',
      gridPos: { h: 8, w: 8, x: 16, y: 16 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: { mode: 'absolute', steps: [] }, mappings: [] },
        overrides: [
          { matcher: { id: 'byName', options: 'cost' }, properties: [{ id: 'unit', value: 'currencyUSD' }, { id: 'decimals', value: 4 }] },
        ],
      },
      options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, orientation: 'vertical', textMode: 'auto', colorMode: 'value', graphMode: 'none' },
      targets: [
        { e: instant(`sum(sum_over_time(${RUN} | json | context_conversation_id="$session" | unwrap payload_run_cost_usd [$__range]))`, '$__range'), legend: 'cost', refId: 'A' },
        { e: instant(`sum(sum_over_time(${RUN} | json | context_conversation_id="$session" | unwrap payload_num_turns [$__range]))`, '$__range'), legend: 'turns', refId: 'B' },
        { e: instant(`sum(sum_over_time(${RUN} | json | context_conversation_id="$session" | unwrap payload_input_tokens [$__range])) + sum(sum_over_time(${RUN} | json | context_conversation_id="$session" | unwrap payload_output_tokens [$__range]))`, '$__range'), legend: 'tokens total', refId: 'C' },
      ],
    }),
    timeseries({
      id: 4,
      title: 'Turn latency (llm.call durations)',
      description:
        'LLM call durations for the selected conversation. llm.call events carry context_conversation_id — the durable conversation-file ID — so this panel is filtered to $session (a conversation_id value) consistently with all other panels in the dashboard.',
      gridPos: { h: 8, w: 12, x: 0, y: 24 },
      fieldConfig: { defaults: { unit: 'ms', custom: { drawStyle: 'line', fillOpacity: 10, lineWidth: 2, stacking: { mode: 'none' } } }, overrides: [] },
      options: legendBottom(false),
      targets: [{ e: quantile({ q: 0.5, kind: 'llm.call', field: 'payload_duration_ms', window: '$__interval', filter: ' | context_conversation_id="$session"' }), legend: 'llm.call p50' }],
    }),
    traces({
      id: 5,
      title: 'Dispatch tree',
      description:
        "Sub-agent dispatch spans for this session. The parent/child tree shows the full dispatch hierarchy. Uses Tempo TraceQL filtered to dispatch.agent spans with the session's trace ID.",
      gridPos: { h: 8, w: 12, x: 12, y: 24 },
      fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
      query: '{ .session_id = "$session" && name = "dispatch.agent" }',
    }),
    table({
      id: 6,
      title: 'Tool failures in this session',
      description: 'All tool failures that occurred in the selected session, with category and error preview.',
      gridPos: { h: 10, w: 12, x: 0, y: 32 },
      mode: 'range',
      fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
      options: { showHeader: true, footer: { show: false } },
      transformations: [{ id: 'extractFields', options: { source: 'labels', replace: false } }],
      targets: [{ e: stream(`${telemetry('tool.failure')} | json | context_conversation_id="$session"`) }],
    }),
    table({
      id: 7,
      title: 'Permission decisions in this session',
      description: "All permission checks in the selected session: allowed and denied, with the deciding layer and the engine's stated reason.",
      gridPos: { h: 10, w: 12, x: 12, y: 32 },
      mode: 'range',
      fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
      options: { showHeader: true, footer: { show: false } },
      transformations: [{ id: 'extractFields', options: { source: 'labels', replace: false } }],
      targets: [{ e: stream(`${telemetry('permission.decision')} | json | context_conversation_id="$session"`) }],
    }),
    logs({
      id: 9,
      title: 'Engine log for this session',
      description:
        'All engine/extension/desktop log lines in the time window that carry conversation_id. Engine log lines emit session_id = the client session key (UUID format for desktop clients) and conversation_id = the engine conversation-file ID ({millis}-{hex}). This panel filters on conversation_id to correlate engine log output with telemetry events for the selected session.',
      gridPos: { h: 12, w: 24, x: 0, y: 42 },
      options: {
        showTime: true,
        showLabels: true,
        showCommonLabels: false,
        wrapLogMessage: true,
        prettifyLogMessage: true,
        enableLogDetails: true,
        dedupStrategy: 'none',
        sortOrder: 'Ascending',
      },
      target: { e: stream('{component=~".+"} | json | conversation_id="$session"') },
    }),
  ];

  return {
    uid: 'ion-forensics',
    title: 'Ion Conversation Forensics',
    description: 'Ion forensics — what happened in this conversation?',
    tags: ['ion', 'forensics'],
    schemaVersion: 39,
    version: 5,
    refresh: '30s',
    timeFrom: 'now-24h',
    folder: 'forensics',
    file: 'ion-forensics',
    panels,
    templating: [
      {
        name: 'session',
        label: 'Session ID',
        description:
          'The conversation session ID to inspect. Set by clicking a row in the leaderboard or by inbound data links from other dashboards. Textbox because session IDs live in log line bodies, not index labels — a label_values dropdown is impossible here without cardinality violations.',
        type: 'textbox',
        current: { value: '' },
        query: '',
        hide: 0,
      },
    ],
    annotations: [
      { name: 'Compaction', type: 'logs', rawQuery: '{service_name="ion-telemetry", kind="compaction"} | json | context_conversation_id=~"$session"', iconColor: 'blue', titleFormat: 'compaction: {{payload_trigger}} reclaimed {{payload_tokens_reclaimed}} tokens' },
      { name: 'Model fallback', type: 'logs', rawQuery: '{service_name="ion-telemetry", kind="provider.fallback"} | json', iconColor: 'orange', titleFormat: 'fallback: {{payload_requested_model}} -> {{payload_fallback_model}} ({{payload_reason}})' },
      { name: 'Extension respawn', type: 'logs', rawQuery: '{service_name="ion-telemetry", kind="extension.respawn"} | json | context_conversation_id=~"$session"', iconColor: 'red', titleFormat: 'respawn: {{payload_extension}} attempt {{payload_attempt}}/{{payload_budget_max}}' },
    ],
  };
}
