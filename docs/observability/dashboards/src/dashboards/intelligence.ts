// Recipe: Ion Product Intelligence (uid ion-intel).
//
// "What are users doing that I didn't anticipate?" 30-day trends.
//
// OVERCOUNT FIXES (17-suspect class):
//   * Panel 7 "Autonomy ratio trend (daily)": was [1d] accumulation on a range
//     timeseries — every step re-summed a full day, so a 30-day range plotted
//     ~30x the true per-bucket count in every point. Now $__interval: each step
//     sums only its own bucket. Title stays "(daily)" — the dashboard's 30d
//     range with Grafana's auto-interval buckets to ~daily steps, which is the
//     panel's stated intent; the ratio itself is dimensionless so the shape is
//     unchanged and correct.
//   * Panel 13 "Thrash trend (daily)": same [1d]->$__interval fix on both the
//     failures and executions terms.

import type { Dashboard } from '../dashboard.ts';
import { row, text, piechart, timeseries, table, barchart } from '../panels.ts';
import { accumulation, instant, telemetry } from '../queries.ts';
import { quantile, costPerRunByModelInterval } from '../queries-latency.ts';
import { groupedKindCount, groupedKindSeries, groupedUnwrapSeries } from '../queries-logs.ts';

const lineDefaults = (unit: string, extra: Record<string, unknown> = {}, stacking = 'none') => ({
  defaults: {
    unit,
    ...extra,
    custom: { drawStyle: 'line', fillOpacity: extra.fillOpacity ?? 10, lineWidth: 2, stacking: { mode: stacking } },
  },
  overrides: [],
});
const legendBottom = (multi = true) => ({
  legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
  tooltip: { mode: multi ? 'multi' : 'single' },
});

const INTRO =
  "## What the usage says about the product\n\nThirty days of runs, aggregated. Which models earn their cost, whether the provider market is treating the engine well, which tools the agent actually reaches for, how autonomy trends as trust rules mature, and whether caching and compaction are pulling their economic weight. This is the dashboard you read before deciding what to build next, not the one you stare at during an incident.\n\n> **Default time range is 30 days.** Panels use the dashboard time range. Adjust the picker for shorter trend windows.\n> **No data on Tier-4 panels?** Panels marked with a Phase-B note bind to events not yet emitted. The model-market and tool-usage panels bind to shipped Tier-1 events and populate now.";

// The daily autonomy ratio, per-interval (overcount fix). Both terms bind
// $__interval so each step is a self-contained bucket ratio.
const autonomyRatioInterval = () =>
  accumulation(
    `sum(count_over_time(${telemetry('permission.decision')} | json | payload_decision="allow" [$__interval])) / sum(count_over_time(${telemetry('permission.decision')} | json [$__interval]))`,
    '$__interval',
  );

export function intelligenceDashboard(): Dashboard {
  const panels = [
    text(1, { h: 4, w: 24, x: 0, y: 0 }, INTRO),
    row(10, 'Model market', 4),
    piechart({
      id: 2,
      title: 'Run share by model',
      description: 'Which models are handling the most runs. Shipped structured metadata label; no parser required.',
      gridPos: { h: 8, w: 8, x: 0, y: 5 },
      fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
      options: {
        pieType: 'pie',
        legend: { displayMode: 'list', placement: 'right', showLegend: true },
        tooltip: { mode: 'single' },
      },
      targets: [{ e: groupedKindCount('run.complete', ['payload_model'], '$__range'), legend: '{{payload_model}}' }],
    }),
    timeseries({
      id: 3,
      title: 'Cost per run by model (weekly)',
      description:
        'Average cost per run, broken down by model, in weekly buckets. Rising cost-per-run for a model means sessions are getting longer or the model is being used for more expensive tasks.',
      gridPos: { h: 8, w: 16, x: 8, y: 5 },
      fieldConfig: lineDefaults('currencyUSD', { decimals: 4 }),
      options: legendBottom(true),
      targets: [{ e: costPerRunByModelInterval(), legend: '{{payload_model}}' }],
    }),
    table({
      id: 4,
      title: 'Provider league table',
      description:
        "One row per model: TTFT p50, stall count, retry count, fallback-out count. The 'should we reroute traffic' view. Phase-B events required for all columns except run count.",
      gridPos: { h: 10, w: 12, x: 0, y: 13 },
      mode: 'instant',
      fieldConfig: {
        defaults: { unit: 'short' },
        // Header override targets the renamed column, not the raw 'Value #A'.
        overrides: [{ matcher: { id: 'byName', options: 'TTFT p50' }, properties: [{ id: 'unit', value: 'ms' }] }],
      },
      options: { showHeader: true, footer: { show: false } },
      // joinByField leaves Grafana's generic 'Value #A / Value #C' headers; the
      // organize stage renames every value column to a human header and relabels
      // the join key. Without it the table reads 'Time 1 / Value #A / Time 2 /
      // Value #C'. The fallback series is relabeled to the shared join key so its
      // count lands on the model's row instead of a separate label column.
      transformations: [
        { id: 'joinByField', options: { byField: 'payload_model', mode: 'outerTabular' } },
        {
          id: 'organize',
          options: {
            renameByName: {
              payload_model: 'Model',
              'Value #A': 'TTFT p50',
              'Value #B': 'Stalls',
              'Value #C': 'Retries',
              'Value #D': 'Fallbacks out',
            },
          },
        },
      ],
      targets: [
        { e: quantile({ q: 0.5, kind: 'provider.ttft', field: 'payload_ttft_ms', window: '$__range', by: ['payload_model'] }), legend: 'TTFT p50 {{payload_model}}', refId: 'A' },
        { e: groupedKindCount('provider.stall', ['payload_model'], '$__range'), legend: 'stalls {{payload_model}}', refId: 'B' },
        { e: groupedKindCount('provider.retry', ['payload_model'], '$__range'), legend: 'retries {{payload_model}}', refId: 'C' },
        // Fallback events key the model that fell back as payload_requested_model,
        // not payload_model. Alias it to the join key so the count lands on the
        // model's row instead of a separate, never-joining column.
        { e: instant(`label_replace(sum by (payload_requested_model) (count_over_time(${telemetry('provider.fallback')} | json [$__range])), "payload_model", "$1", "payload_requested_model", "(.+)")`, '$__range'), legend: 'fallbacks_out {{payload_model}}', refId: 'D' },
      ],
    }),
    timeseries({
      id: 5,
      title: 'Fallback pressure (weekly)',
      description:
        'Fallback events grouped by reason. A rising fallback rate means provider reliability is degrading or capacity is saturated.',
      gridPos: { h: 10, w: 12, x: 12, y: 13 },
      fieldConfig: lineDefaults('short', {}, 'normal'),
      options: legendBottom(true),
      targets: [{ e: groupedKindSeries('provider.fallback', ['payload_reason']), legend: '{{payload_reason}}' }],
    }),
    row(20, 'Behavior mix', 23),
    barchart({
      id: 6,
      title: 'Tool usage mix',
      description:
        'Top 15 most-called tools over the dashboard time range. What the agent actually reaches for. Shipped Tier-1 structured metadata; no parser required.',
      gridPos: { h: 10, w: 12, x: 0, y: 24 },
      fieldConfig: { defaults: { unit: 'short', custom: { fillOpacity: 80 } }, overrides: [] },
      options: {
        orientation: 'auto',
        legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
        tooltip: { mode: 'single' },
        xTickLabelRotation: -45,
      },
      targets: [
        {
          e: instant(`topk(15, sum by (tool) (count_over_time(${telemetry('tool.execute')} [$__range])))`, '$__range'),
          legend: '{{tool}}',
        },
      ],
    }),
    timeseries({
      id: 7,
      title: 'Autonomy ratio trend (daily)',
      description:
        'The fraction of permission checks that resolve to allow, sampled per interval. Rising means the rule set is absorbing what used to need asking. A healthy trend is flat or rising. Phase-B event required.',
      gridPos: { h: 10, w: 12, x: 12, y: 24 },
      fieldConfig: {
        defaults: {
          unit: 'percentunit',
          min: 0,
          max: 1,
          custom: { drawStyle: 'line', fillOpacity: 20, lineWidth: 2, stacking: { mode: 'none' } },
          thresholds: {
            mode: 'absolute',
            steps: [
              { color: 'red', value: null },
              { color: 'yellow', value: 0.5 },
              { color: 'green', value: 0.8 },
            ],
          },
        },
        overrides: [],
      },
      options: legendBottom(false),
      targets: [{ e: autonomyRatioInterval(), legend: 'autonomy ratio' }],
    }),
    timeseries({
      id: 8,
      title: 'Sub-agent adoption (weekly)',
      description:
        'Which sub-agents are being dispatched and how often. Rising dispatch counts signal that users are leaning into multi-agent workflows. Phase-B event required.',
      gridPos: { h: 10, w: 12, x: 0, y: 34 },
      fieldConfig: lineDefaults('short', {}, 'normal'),
      options: legendBottom(true),
      targets: [{ e: groupedKindSeries('dispatch.agent', ['payload_agent']), legend: '{{payload_agent}}' }],
    }),
    timeseries({
      id: 9,
      title: 'Dispatch depth distribution (weekly)',
      description:
        'How deep the sub-agent dispatch trees go. Depth 1 is a direct dispatch; higher values are nested. A growing tail at depth 3+ may signal runaway recursion or unexpected orchestration patterns.',
      gridPos: { h: 10, w: 12, x: 12, y: 34 },
      fieldConfig: lineDefaults('short', {}, 'normal'),
      options: legendBottom(true),
      targets: [{ e: groupedKindSeries('dispatch.agent', ['payload_dispatch_depth']), legend: 'depth {{payload_dispatch_depth}}' }],
    }),
    row(30, 'Economics', 44),
    timeseries({
      id: 11,
      title: 'Cache savings trend (weekly)',
      description:
        'Total dollars saved by prompt caching per week. A flat or declining line means caching is not being leveraged — look at session length and repeat-prefix patterns. Phase-B event required.',
      gridPos: { h: 8, w: 8, x: 0, y: 45 },
      fieldConfig: lineDefaults('currencyUSD', { decimals: 4, fillOpacity: 20 }),
      options: legendBottom(false),
      targets: [
        {
          e: accumulation(`sum(sum_over_time(${telemetry('cache.savings')} | json | unwrap payload_savings_usd [$__interval]))`, '$__interval'),
          legend: 'cache savings (USD)',
        },
      ],
    }),
    timeseries({
      id: 12,
      title: 'Tokens reclaimed by compaction (weekly)',
      description:
        'Tokens freed by context compaction per week, split by trigger type (automatic vs manual). This is the efficiency dividend of the compaction subsystem. Phase-B event required.',
      gridPos: { h: 8, w: 8, x: 8, y: 45 },
      fieldConfig: lineDefaults('short', {}, 'normal'),
      options: legendBottom(true),
      targets: [{ e: groupedUnwrapSeries('compaction', 'payload_tokens_reclaimed', ['payload_trigger']), legend: '{{payload_trigger}}' }],
    }),
    timeseries({
      id: 13,
      title: 'Thrash trend (daily)',
      description:
        'Tool failure rate: failures divided by total tool executions, per interval. The long-run quality health line. A rising trend means tooling reliability is degrading relative to usage.',
      gridPos: { h: 8, w: 8, x: 16, y: 45 },
      fieldConfig: {
        defaults: {
          unit: 'percentunit',
          min: 0,
          custom: { drawStyle: 'line', fillOpacity: 10, lineWidth: 2, stacking: { mode: 'none' } },
          thresholds: {
            mode: 'absolute',
            steps: [
              { color: 'green', value: null },
              { color: 'yellow', value: 0.05 },
              { color: 'red', value: 0.15 },
            ],
          },
        },
        overrides: [],
      },
      options: legendBottom(false),
      transformations: [
        {
          id: 'calculateField',
          options: {
            alias: 'failure rate',
            mode: 'binaryOperation',
            binary: { left: 'failures', right: 'executions', operator: '/' },
          },
        },
      ],
      targets: [
        { e: accumulation(`sum(count_over_time(${telemetry('tool.failure')} | json [$__interval]))`, '$__interval'), legend: 'failures', refId: 'A' },
        { e: accumulation(`sum(count_over_time(${telemetry('tool.execute')} [$__interval]))`, '$__interval'), legend: 'executions', refId: 'B' },
      ],
    }),
  ];

  return {
    uid: 'ion-intel',
    title: 'Ion Product Intelligence',
    description: "Ion product intelligence — what are users doing that I didn't anticipate?",
    tags: ['ion', 'intelligence'],
    schemaVersion: 39,
    version: 3,
    refresh: '5m',
    timeFrom: 'now-30d',
    folder: 'intelligence',
    file: 'ion-intelligence',
    panels,
    templating: [
      {
        name: 'model',
        label: 'Model',
        description: 'Filter by model name. Accepts regex. Default matches all.',
        type: 'textbox',
        current: { value: '.+' },
        query: '.+',
        hide: 0,
      },
    ],
  };
}
