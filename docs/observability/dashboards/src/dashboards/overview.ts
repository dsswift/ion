// Recipe: Ion Overview (uid ion-overview).
//
// The landing dashboard — headline signals with links into the packs. Migrated
// semantically-identical. Note the overview verdict tile uses the payload_
// cost field and rate() volume, distinct from the cost pack's bare field; both
// are preserved exactly (see queries-cost.ts note on the field split).

import type { Dashboard } from '../dashboard.ts';
import { text, stat, timeseries, logs } from '../panels.ts';
import { stream } from '../queries.ts';
import { totalSpendPayload, runCount } from '../queries-cost.ts';
import { levelCount, logRateByComponent, ingestFreshnessMinutes } from '../queries-logs.ts';

const fixed = (steps: unknown[] = []) => ({ mode: 'absolute', steps });
const statOptions = (colorMode: string) => ({
  reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
  orientation: 'auto',
  textMode: 'auto',
  colorMode,
  graphMode: 'none',
});
const packLink = (title: string, url: string) => [{ title, url, targetBlank: false }];

const INTRO =
  '## Ion Observability Overview\n\nThe landing dashboard. **Verdict row**: headline signals over the dashboard time range, with links into the packs. Green = healthy. Any orange or red — click through to the relevant pack.\n\n| Pack | Question | Dashboard |\n|---|---|---|\n| Cost | What is it costing me? | [Ion Cost](/d/ion-cost) |\n| Reliability | Is Ion healthy? | [Ion Errors & Health](/d/ion-errors-health) |\n| Live | What is Ion doing right now? | [Ion Live Logs](/d/ion-logs) |\n| Fleet | Who is running Ion, where, on what version? | [Ion Fleet](/d/ion-fleet) |\n| Users | Who is using Ion and what is their footprint? | [Ion Users](/d/ion-users) |';

const logsOpts = (showLabels: boolean) => ({
  showTime: true,
  showLabels,
  showCommonLabels: false,
  wrapLogMessage: true,
  prettifyLogMessage: true,
  enableLogDetails: true,
  dedupStrategy: 'none',
  sortOrder: 'Descending',
});

export function overviewDashboard(): Dashboard {
  const panels = [
    text(1, { h: 4, w: 24, x: 0, y: 0 }, INTRO),
    stat({
      id: 2,
      title: 'Errors',
      gridPos: { h: 4, w: 4, x: 0, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'orange', value: 1 },
            { color: 'red', value: 10 },
          ]),
          mappings: [],
          links: packLink('Errors and Health', '/d/ion-errors-health'),
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: levelCount('ERROR', '$__range') }],
    }),
    stat({
      id: 3,
      title: 'Warnings',
      gridPos: { h: 4, w: 4, x: 4, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'yellow', value: 5 },
            { color: 'orange', value: 20 },
          ]),
          mappings: [],
          links: packLink('Errors and Health', '/d/ion-errors-health'),
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: levelCount('WARN', '$__range') }],
    }),
    stat({
      id: 4,
      title: 'Spend',
      gridPos: { h: 4, w: 4, x: 8, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'currencyUSD',
          decimals: 4,
          color: { mode: 'fixed', fixedColor: 'blue' },
          thresholds: fixed(),
          mappings: [],
          links: packLink('Ion Cost Dashboard', '/d/ion-cost'),
          noValue: 'telemetry off',
        },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: totalSpendPayload() }],
    }),
    stat({
      id: 5,
      title: 'Runs',
      gridPos: { h: 4, w: 4, x: 12, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'fixed', fixedColor: 'blue' },
          thresholds: fixed(),
          mappings: [],
          links: packLink('Ion Cost Dashboard', '/d/ion-cost'),
          noValue: 'telemetry off',
        },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: runCount() }],
    }),
    stat({
      id: 10,
      title: 'Ingest freshness by component (min since last line)',
      description:
        'Minutes since the most recent log line for each component. Green < 5m, orange < 30m, ' +
        'red beyond. A wedged tailer (one component stops flowing while the others advance — ' +
        'see README "Tailer wedge") turns its tile red within minutes. The [24h] lookback keeps ' +
        'a long-wedged component visible as a growing red value instead of dropping it.',
      gridPos: { h: 4, w: 8, x: 16, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'm',
          decimals: 1,
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'orange', value: 5 },
            { color: 'red', value: 30 },
          ]),
          mappings: [],
          links: packLink('Ion Live Logs', '/d/ion-logs'),
        },
        overrides: [],
      },
      // Per-series display: one labeled cell per component, NOT a single reduced
      // value. `values: true` emits every series (a bare `lastNotNull` reduction
      // with values:false collapses all components into one number — the operator
      // saw "1.6 hours" with no component label). `textMode: value_and_name`
      // stamps the {{component}} label on each cell so every tile carries both
      // its component name and its unit-formatted value.
      options: {
        ...statOptions('background'),
        textMode: 'value_and_name',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
      },
      targets: [{ e: ingestFreshnessMinutes('24h'), legend: '{{component}}' }],
    }),
    timeseries({
      id: 6,
      title: 'Log volume by component',
      gridPos: { h: 8, w: 24, x: 0, y: 8 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          custom: { drawStyle: 'bars', fillOpacity: 50, stacking: { mode: 'normal', group: 'A' } },
        },
        overrides: [],
      },
      options: {
        legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
      targets: [{ e: logRateByComponent('1m'), legend: '{{component}}' }],
    }),
    logs({
      id: 7,
      title: 'Error logs',
      gridPos: { h: 8, w: 12, x: 0, y: 16 },
      options: logsOpts(false),
      target: { e: stream('{level="ERROR"}') },
    }),
    logs({
      id: 8,
      title: 'Extension activity',
      gridPos: { h: 8, w: 12, x: 12, y: 16 },
      options: logsOpts(false),
      target: { e: stream('{component="extension"}') },
    }),
    logs({
      id: 9,
      title: 'Recent logs',
      gridPos: { h: 10, w: 24, x: 0, y: 24 },
      options: logsOpts(false),
      target: { e: stream('{component=~".+"}') },
    }),
  ];

  return {
    uid: 'ion-overview',
    title: 'Ion Overview',
    description: 'Ion unified overview — headline signals with links into the story-packs',
    tags: ['ion'],
    schemaVersion: 39,
    version: 5,
    refresh: '30s',
    timeFrom: 'now-1h',
    folder: '',
    file: 'ion-overview',
    panels,
  };
}
