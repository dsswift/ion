// Recipe: Ion Extensions (uid ion-extensions).
//
// Cost attribution by extension. Reconciliation-critical: the ranked bargauge,
// the pie, and the model-mix all share extensionSpend()/spendByExtension() so
// their totals reconcile to the headline by construction. Migrated
// semantically-identical from the audited commit 013be86d; instant windows
// follow the dashboard time picker per ADR-022.

import type { Dashboard } from '../dashboard.ts';
import { row, bargauge, piechart, timeseries, table, stat } from '../panels.ts';
import {
  spendByExtension,
  spendByExtensionModel,
  spendOverTimeByExtensionVersion,
  spendByVersion,
  runsByVersion,
  dispatchesByExtension,
  tokensOverTimeByExtension,
} from '../queries-cost.ts';

const currency = (decimals = 4, extra: Record<string, unknown> = {}) => ({
  defaults: { unit: 'currencyUSD', decimals, ...extra },
});

export function extensionsDashboard(): Dashboard {
  const panels = [
    row(1, 'Spend by Extension', 0),
    bargauge({
      id: 2,
      title: 'Spend by Extension (ranked)',
      description:
        "Total run.complete cost summed per extension. Lines without context_extension group as 'unattributed'. Filter using the Extension variable above.",
      gridPos: { x: 0, y: 1, w: 12, h: 8 },
      options: {
        orientation: 'horizontal',
        reduceOptions: { calcs: ['sum'] },
        displayMode: 'gradient',
        showUnfilled: true,
      },
      fieldConfig: {
        defaults: {
          unit: 'currencyUSD',
          decimals: 4,
          thresholds: {
            mode: 'absolute',
            steps: [
              { color: 'green', value: null },
              { color: 'yellow', value: 0.1 },
              { color: 'red', value: 1.0 },
            ],
          },
        },
      },
      targets: [{ e: spendByExtension(), legend: '{{context_extension}}' }],
    }),
    piechart({
      id: 3,
      title: 'Spend Share by Extension',
      description:
        'Proportion of total cost attributable to each extension. Unattributed runs (no context_extension) appear as a separate slice when present.',
      gridPos: { x: 12, y: 1, w: 12, h: 8 },
      options: {
        pieType: 'pie',
        displayLabels: ['name', 'percent'],
        legend: { displayMode: 'table', placement: 'right', showLegend: true, values: ['value', 'percent'] },
      },
      fieldConfig: currency(4),
      targets: [{ e: spendByExtension(), legend: '{{context_extension}}' }],
    }),
    row(4, 'Model Mix and Cost Over Time', 9),
    bargauge({
      id: 5,
      title: 'Per-Extension Model Mix (spend)',
      description:
        'Cost broken down by extension AND model. Shows which models each extension drives and how much each model costs within an extension. Filter by Extension variable to drill into one extension.',
      gridPos: { x: 0, y: 10, w: 12, h: 8 },
      options: { orientation: 'horizontal', reduceOptions: { calcs: ['sum'] }, displayMode: 'gradient' },
      fieldConfig: currency(4),
      targets: [{ e: spendByExtensionModel(), legend: '{{context_extension}} / {{model}}' }],
    }),
    timeseries({
      id: 6,
      title: 'Cost Over Time by Extension (with version legend)',
      description:
        "Run cost summed per $__interval window (matches the panel's step so the area integrates to the same range total as the ranked bar and pie), colored by extension. When multiple versions of the same extension exist in the window, each context_extension_version appears as a distinct series so version rollouts are visible. Extensions with no version report just the extension name (no trailing 'v'); lines with no extension group as 'unattributed'.",
      gridPos: { x: 12, y: 10, w: 12, h: 8 },
      options: {
        legend: { displayMode: 'table', placement: 'bottom', calcs: ['sum'] },
        tooltip: { mode: 'multi' },
      },
      fieldConfig: { defaults: { unit: 'currencyUSD', custom: { lineWidth: 2 } } },
      targets: [{ e: spendOverTimeByExtensionVersion(), legend: '{{context_extension}}{{vsuffix}}' }],
    }),
    row(7, 'Agent Dispatch Attribution', 18),
    table({
      id: 8,
      title: 'Extension → Agent Drill-Down (dispatch.agent)',
      description:
        'Every dispatch.agent span attributed to an extension. Shows which agent names each extension dispatched, how many times, and the total dispatch cost (run_cost_usd from the matching run.complete). Useful for understanding sub-agent spend per extension.',
      gridPos: { x: 0, y: 19, w: 24, h: 10 },
      mode: 'instant',
      options: { sortBy: [{ displayName: 'Dispatch Count', desc: true }] },
      fieldConfig: { defaults: {}, overrides: [] },
      // Instant table over span attributes (payload_-prefixed). Rename the label
      // columns and the bare "Value" to human headers.
      transformations: [
        {
          id: 'organize',
          options: {
            renameByName: {
              payload_extension: 'Extension',
              payload_extension_version: 'Version',
              payload_agent: 'Agent',
              Value: 'Dispatch Count',
            },
          },
        },
      ],
      targets: [
        { e: dispatchesByExtension(), legend: '{{payload_extension}} | v{{payload_extension_version}} | {{payload_agent}}' },
      ],
    }),
    row(9, 'Version Comparison', 29),
    bargauge({
      id: 10,
      title: 'Cost per Version',
      description:
        "Total run.complete cost grouped by extension_version. Use this to compare spend before and after a version bump. Select a specific extension using the Extension variable to isolate one extension's versions.",
      gridPos: { x: 0, y: 30, w: 12, h: 8 },
      options: { orientation: 'horizontal', reduceOptions: { calcs: ['sum'] }, displayMode: 'gradient' },
      fieldConfig: currency(4),
      targets: [{ e: spendByVersion(), legend: '{{context_extension}} v{{context_extension_version}}' }],
    }),
    stat({
      id: 11,
      title: 'Runs per Version',
      description:
        'Total run count grouped by extension version. A version comparison companion to the cost panel — shows whether a cost change is driven by price-per-run or run volume.',
      gridPos: { x: 12, y: 30, w: 12, h: 8 },
      options: { reduceOptions: { calcs: ['sum'] }, orientation: 'horizontal' },
      fieldConfig: { defaults: { unit: 'short' } },
      targets: [{ e: runsByVersion(), legend: '{{context_extension}} v{{context_extension_version}}' }],
    }),
    row(12, 'Runs and Tokens', 38),
    timeseries({
      id: 13,
      title: 'Token Usage Over Time by Extension',
      description:
        "Input and output tokens summed per $__interval window (matches the panel's step so the totals do not overcount), colored by extension. Helps distinguish token-volume growth from model-price changes when cost trends diverge.",
      gridPos: { x: 0, y: 39, w: 24, h: 8 },
      options: {
        legend: { displayMode: 'table', placement: 'bottom', calcs: ['sum'] },
        tooltip: { mode: 'multi' },
      },
      fieldConfig: { defaults: { unit: 'short', custom: { lineWidth: 2 } } },
      targets: [
        { e: tokensOverTimeByExtension('input_tokens'), legend: '{{context_extension}} input', refId: 'A' },
        { e: tokensOverTimeByExtension('output_tokens'), legend: '{{context_extension}} output', refId: 'B' },
      ],
    }),
  ];

  return {
    uid: 'ion-extensions',
    title: 'Ion Extensions',
    description:
      "Cost attribution by extension. Panels use context_extension and context_extension_version structured-metadata fields (promoted by Alloy from the telemetry context block). Old log lines without these fields group as 'unattributed'.",
    tags: ['ion', 'extensions', 'cost'],
    schemaVersion: 36,
    version: 3,
    refresh: '1m',
    timeFrom: 'now-24h',
    folder: 'extensions',
    file: 'ion-extensions',
    panels,
    templating: [
      // `context_extension` / `context_extension_version` are PARSED JSON
      // fields (extracted by `| json` at query time), NOT indexed stream
      // labels. Grafana's `label_values()` query variable resolves against
      // Loki's label API, which only knows stream labels (service, kind,
      // component, ...) — so `label_values(..., context_extension)` returns an
      // empty set and the dropdown never populates, leaving `$extension`
      // unresolved. Every panel filters `context_extension =~ "$extension"`, so
      // an unresolved variable breaks the whole dashboard. A textbox defaulting
      // to `.*` matches all extensions (including unattributed runs, whose label
      // is absent — `.*` matches the empty string) and lets the operator type a
      // regex to scope. This mirrors the Explore Cookbook's `extension` var.
      {
        name: 'extension',
        label: 'Extension',
        description: "Extension name (e.g. 'ion-dev') to scope panels. Accepts regex. Default matches all, including unattributed runs.",
        type: 'textbox',
        current: { value: '.*' },
        query: '.*',
        hide: 0,
      },
      {
        name: 'version',
        label: 'Version',
        description: 'Extension manifest version to scope panels. Accepts regex. Default matches all.',
        type: 'textbox',
        current: { value: '.*' },
        query: '.*',
        hide: 0,
      },
    ],
  };
}
