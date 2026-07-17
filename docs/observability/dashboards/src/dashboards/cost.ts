// Recipe: Ion Cost (uid ion-cost).
//
// "Where does the money go?" Migrated semantically-identical from the audited
// original. The headline uses the bare/payload cost fields exactly as the
// original did (see queries-cost.ts note on the field split). Panels 12-16 are
// the Tier-4 cache/sub-agent/fallback intelligence panels.

import type { Dashboard } from '../dashboard.ts';
import { row, text, stat, timeseries, piechart, logs, table } from '../panels.ts';
import { instant, accumulation, telemetry } from '../queries.ts';
import {
  totalSpendBare,
  runCount,
  costByModel,
} from '../queries-cost.ts';
import { totalUnwrapSeries } from '../queries-logs.ts';

const RUN = telemetry('run.complete');
const fixed = (steps: unknown[] = []) => ({ mode: 'absolute', steps });
const blueStat = (unit: string, decimals?: number) => ({
  defaults: {
    unit,
    ...(decimals !== undefined ? { decimals } : {}),
    color: { mode: 'fixed', fixedColor: 'blue' },
    thresholds: fixed(),
    mappings: [],
  },
  overrides: [],
});
const statOptions = (colorMode = 'value') => ({
  reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
  orientation: 'auto',
  textMode: 'auto',
  colorMode,
  graphMode: 'none',
});

const INTRO =
  '## Where the money goes.\n\nEvery completed run reports its cost, tokens, and cache usage. The verdict row answers "what did the selected time range cost." The rows below answer the sharper questions: how many dollars caching saved (real rates when models.json carries them, an assumed 0.1x rate when it does not, and the panel legend tells you which), how much of the spend was sub-agent work dispatched under the hood, and what model fallbacks did to the bill. Click any session to open the full forensics view for that conversation.\n\n> **No data on cost panels?** Telemetry is not enabled. Add `"telemetry": {"enabled": true, "targets": ["file"], "filePath": "~/.ion/telemetry.jsonl"}` to `~/.ion/engine.json`, restart the engine, then run `docker compose restart alloy`. Tier-4 panels (cache savings, sub-agent tax, fallback routes) require the Phase-B engine rebuild; queries are valid and will populate once that ships.';

export function costDashboard(): Dashboard {
  const panels = [
    text(1, { h: 4, w: 24, x: 0, y: 0 }, INTRO),
    stat({
      id: 2,
      title: 'Spend',
      gridPos: { h: 4, w: 6, x: 0, y: 4 },
      fieldConfig: blueStat('currencyUSD', 4),
      options: statOptions('value'),
      targets: [{ e: totalSpendBare(), legend: 'Per-run spend (excl sub-agents)' }],
    }),
    stat({
      id: 3,
      title: 'Runs',
      gridPos: { h: 4, w: 6, x: 6, y: 4 },
      fieldConfig: blueStat('short'),
      options: statOptions('value'),
      targets: [{ e: runCount() }],
    }),
    stat({
      id: 4,
      title: 'Avg Cost / Run',
      gridPos: { h: 4, w: 6, x: 12, y: 4 },
      fieldConfig: blueStat('currencyUSD', 4),
      options: statOptions('value'),
      targets: [
        {
          e: accumulation(
            `sum(sum_over_time(${RUN} | json | unwrap payload_run_cost_usd [$__range])) / sum(count_over_time(${RUN}[$__range]))`,
            '$__range',
          ),
        },
      ],
    }),
    stat({
      id: 5,
      title: 'Cache Hit Ratio',
      gridPos: { h: 4, w: 6, x: 18, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'percentunit',
          decimals: 1,
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'red', value: null },
            { color: 'yellow', value: 0.3 },
            { color: 'green', value: 0.6 },
          ]),
          mappings: [],
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [
        {
          e: accumulation(
            `sum(sum_over_time(${RUN} | json | unwrap payload_cache_read_input_tokens [$__range])) / (sum(sum_over_time(${RUN} | json | unwrap payload_input_tokens [$__range])) + sum(sum_over_time(${RUN} | json | unwrap payload_cache_read_input_tokens [$__range])))`,
            '$__range',
          ),
        },
      ],
    }),
    timeseries({
      id: 6,
      title: 'Cost over time (per interval)',
      gridPos: { h: 8, w: 16, x: 0, y: 8 },
      fieldConfig: {
        defaults: {
          unit: 'currencyUSD',
          custom: { drawStyle: 'line', fillOpacity: 20, lineWidth: 2, stacking: { mode: 'none' } },
        },
        overrides: [],
      },
      options: {
        legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
        tooltip: { mode: 'single' },
      },
      targets: [{ e: totalUnwrapSeries('run.complete', 'run_cost_usd'), legend: 'Per-run spend excl sub-agents (USD)' }],
    }),
    piechart({
      id: 7,
      title: 'Cost by model',
      gridPos: { h: 8, w: 8, x: 16, y: 8 },
      fieldConfig: { defaults: { unit: 'currencyUSD' }, overrides: [] },
      options: {
        pieType: 'pie',
        displayLabels: ['name', 'percent'],
        legend: { displayMode: 'table', placement: 'right', showLegend: true, values: ['value'] },
      },
      targets: [{ e: costByModel(), legend: '{{payload_model}}' }],
    }),
    timeseries({
      id: 8,
      title: 'Tokens by type (per interval, stacked)',
      gridPos: { h: 8, w: 12, x: 0, y: 16 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          custom: { drawStyle: 'bars', fillOpacity: 80, stacking: { mode: 'normal', group: 'A' } },
        },
        overrides: [],
      },
      options: {
        legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
      targets: [
        { e: totalUnwrapSeries('run.complete', 'payload_input_tokens'), legend: 'input', refId: 'A' },
        { e: totalUnwrapSeries('run.complete', 'payload_output_tokens'), legend: 'output', refId: 'B' },
        { e: totalUnwrapSeries('run.complete', 'payload_cache_read_input_tokens'), legend: 'cache read', refId: 'C' },
      ],
    }),
    timeseries({
      id: 9,
      title: 'Runs per interval',
      gridPos: { h: 8, w: 12, x: 12, y: 16 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          custom: { drawStyle: 'bars', fillOpacity: 60, stacking: { mode: 'none' } },
        },
        overrides: [],
      },
      options: {
        legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
        tooltip: { mode: 'single' },
      },
      targets: [{ e: accumulation(`sum(count_over_time(${RUN}[$__interval]))`, '$__interval'), legend: 'runs' }],
    }),
    logs({
      id: 10,
      title: 'Recent runs — full cost detail',
      gridPos: { h: 10, w: 24, x: 0, y: 24 },
      target: { e: { expr: RUN, cls: 'instant', window: null } },
    }),
    { ...row(11, 'Tier-4 cost intelligence', 34) },
    stat({
      id: 12,
      title: 'Cache savings (USD)',
      description:
        'Total dollars saved by cache hits. Pricing source shown in D2 legend: models_json = billed rate from models.json; assumed_0.1x = estimated at 10% of input price.',
      gridPos: { h: 4, w: 6, x: 0, y: 35 },
      fieldConfig: {
        defaults: {
          unit: 'currencyUSD',
          decimals: 4,
          color: { mode: 'fixed', fixedColor: 'green' },
          thresholds: fixed(),
          mappings: [],
          links: [{ title: 'Cache savings over time', url: '/d/ion-cost/ion-cost?viewPanel=13' }],
        },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: accumulation(`sum(sum_over_time(${telemetry('cache.savings')} | json | unwrap payload_savings_usd [$__range]))`, '$__range') }],
    }),
    timeseries({
      id: 13,
      title: 'Cache savings over time, split by pricing source',
      description:
        'Legend: models_json = real billed rate from models.json. assumed_0.1x = 10% of input price assumed (models.json does not carry cache pricing for this model). Do not compare the two series as equivalent dollar values.',
      gridPos: { h: 8, w: 18, x: 6, y: 35 },
      fieldConfig: {
        defaults: {
          unit: 'currencyUSD',
          custom: { drawStyle: 'line', fillOpacity: 20, lineWidth: 2, stacking: { mode: 'none' } },
        },
        overrides: [
          {
            matcher: { id: 'byName', options: 'assumed_0.1x' },
            properties: [
              { id: 'custom.lineStyle', value: { dash: [8, 4], fill: 'dash' } },
              { id: 'color', value: { mode: 'fixed', fixedColor: 'orange' } },
            ],
          },
        ],
      },
      options: {
        legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
      targets: [
        {
          e: accumulation(
            `sum by (payload_pricing_source) (sum_over_time(${telemetry('cache.savings')} | json | unwrap payload_savings_usd [$__interval]))`,
            '$__interval',
          ),
          legend: '{{payload_pricing_source}}',
        },
      ],
    }),
    timeseries({
      id: 14,
      title: 'Sub-agent spend vs total spend',
      description:
        'Sub-agent cost from dispatch.agent span-end events (context_session_id join key — both series now group by context_session_id for an apples-to-apples comparison). Total cost from run.complete. The gap is root-agent-only cost.',
      gridPos: { h: 8, w: 12, x: 0, y: 43 },
      fieldConfig: {
        defaults: {
          unit: 'currencyUSD',
          custom: { drawStyle: 'line', fillOpacity: 15, lineWidth: 2, stacking: { mode: 'none' } },
        },
        overrides: [],
      },
      options: {
        legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
      transformations: [
        {
          id: 'calculateField',
          options: {
            alias: 'sub-agent share',
            mode: 'binary',
            binary: { left: 'sub-agent cost', right: 'total cost', operator: '/' },
            reduce: { reducer: 'lastNotNull' },
          },
        },
      ],
      targets: [
        { e: totalUnwrapSeries('dispatch.agent', 'payload_cost_usd'), legend: 'sub-agent cost', refId: 'A' },
        { e: totalUnwrapSeries('run.complete', 'payload_run_cost_usd'), legend: 'total cost', refId: 'B' },
      ],
    }),
    table({
      id: 15,
      title: 'Sub-agent tax by session (range)',
      description:
        'Sub-agent tax by session. dispatch.agent (a span) keys session under payload_session_id; run.complete keys it under context_session_id. The dispatch series is aliased to context_session_id so the join aligns. Ratio = sub-agent cost / total session cost.',
      gridPos: { h: 8, w: 12, x: 12, y: 43 },
      mode: 'instant',
      fieldConfig: {
        defaults: { unit: 'currencyUSD', custom: { align: 'auto', displayMode: 'auto' } },
        overrides: [
          {
            matcher: { id: 'byName', options: 'context_session_id' },
            properties: [
              {
                id: 'links',
                value: [
                  { title: 'Open forensics', url: '/d/ion-forensics/ion-conversation-forensics?var-session=${__value.raw}&${__url_time_range}' },
                ],
              },
            ],
          },
        ],
      },
      options: { footer: { show: false }, sortBy: [{ displayName: 'sub-agent cost', desc: true }] },
      transformations: [
        { id: 'joinByField', options: { byField: 'context_session_id', mode: 'outer' } },
        {
          id: 'calculateField',
          options: {
            alias: 'sub-agent share',
            mode: 'binary',
            binary: { left: 'sub-agent cost', right: 'total cost', operator: '/' },
          },
        },
        { id: 'organize', options: { renameByName: { 'Value #A': 'sub-agent cost', 'Value #B': 'total cost' } } },
      ],
      targets: [
        {
          // dispatch.agent is a span: its session key lands under
          // payload_session_id, while run.complete's is context_session_id.
          // Group by the span field, then alias it to context_session_id so the
          // joinByField(context_session_id) below aligns both sources. Without
          // the alias the join key never matches and every row is half-empty.
          e: instant(
            `label_replace(sum by (payload_session_id) (sum_over_time(${telemetry('dispatch.agent')} | json | unwrap payload_cost_usd [$__range])), "context_session_id", "$1", "payload_session_id", "(.+)")`,
            '$__range',
          ),
          legend: 'sub-agent cost',
          refId: 'A',
        },
        {
          e: instant(
            `sum by (context_session_id) (sum_over_time(${RUN} | json | unwrap payload_run_cost_usd [$__range]))`,
            '$__range',
          ),
          legend: 'total cost',
          refId: 'B',
        },
      ],
    }),
    table({
      id: 16,
      title: 'Fallback cost routes (range)',
      description:
        'Count of fallback hops by requested model, fallback model, and reason. Dollar delta (counterfactual cost of the fallback path vs the requested model) is a Phase-C addition joining run.complete on run_id; the route count is the binding minimum today.',
      gridPos: { h: 8, w: 24, x: 0, y: 51 },
      mode: 'instant',
      fieldConfig: {
        defaults: { unit: 'short', custom: { align: 'auto', displayMode: 'auto' } },
        overrides: [],
      },
      options: { footer: { show: false }, sortBy: [{ displayName: 'Hops', desc: true }] },
      // Instant table: rename the label columns and the bare "Value" so the
      // header reads Requested model / Fallback model / Reason / Hops.
      transformations: [
        {
          id: 'organize',
          options: {
            renameByName: {
              payload_requested_model: 'Requested model',
              payload_fallback_model: 'Fallback model',
              payload_reason: 'Reason',
              Value: 'Hops',
            },
          },
        },
      ],
      targets: [
        {
          e: instant(
            `sum by (payload_requested_model, payload_fallback_model, payload_reason) (count_over_time(${telemetry('provider.fallback')} | json [$__range]))`,
            '$__range',
          ),
          legend: '{{payload_requested_model}} -> {{payload_fallback_model}}',
        },
      ],
    }),
  ];

  return {
    uid: 'ion-cost',
    title: 'Ion Cost',
    description: 'Ion cost dashboard — where does the money go?',
    tags: ['ion', 'cost'],
    schemaVersion: 39,
    version: 6,
    refresh: '30s',
    timeFrom: 'now-24h',
    folder: 'cost',
    file: 'ion-cost',
    panels,
    annotations: [
      {
        name: 'Model fallback',
        expr: '{service_name="ion-telemetry", kind="provider.fallback"} | json',
        iconColor: 'orange',
        step: '60s',
        titleFormat: 'fallback: {{payload_requested_model}} -> {{payload_fallback_model}} ({{payload_reason}})',
      },
      {
        name: 'Compaction',
        expr: '{service_name="ion-telemetry", kind="compaction"} | json',
        iconColor: 'blue',
        step: '60s',
        titleFormat: 'compaction: {{payload_trigger}} tokens_reclaimed={{payload_tokens_reclaimed}}',
      },
    ],
  };
}
