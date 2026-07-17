// Recipe: Ion Fleet (uid ion-fleet).
//
// "Who is running Ion, where, and on what version?" Hosts, installs, and
// version drift over the telemetry stream. Every telemetry line carries
// top-level `host`, `install_id`, and `version`, so the fleet view works on
// any install — including several headless engine instances sharing one host
// (the installs-per-host panel makes that visible).
//
// Per-host error signal: ops-log ERROR lines carry no host identity, so the
// error panels here count telemetry events with a non-empty payload_error —
// the only error signal that is attributable to a host.

import type { Dashboard } from '../dashboard.ts';
import { row, text, stat, timeseries, bargauge, table } from '../panels.ts';
import {
  HOST_PIPE,
  distinctLabelCount,
  installsPerHost,
  hostLastSeenMinutes,
  totalSpend,
  spendBy,
  runsBy,
  kindCountBy,
  activityBy,
  errorEventsBy,
} from '../queries-fleet.ts';

const fixed = (steps: unknown[] = []) => ({ mode: 'absolute', steps });
const statOptions = (colorMode: string) => ({
  reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
  orientation: 'auto',
  textMode: 'auto',
  colorMode,
  graphMode: 'none',
});
const legendBottom = () => ({
  legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
  tooltip: { mode: 'multi', sort: 'desc' },
});
const bars = (fillOpacity: number) => ({
  defaults: { unit: 'short', custom: { drawStyle: 'bars', fillOpacity, stacking: { mode: 'normal', group: 'A' } } },
  overrides: [],
});
const link = (title: string, url: string) => [{ title, url }];

const INTRO =
  '## Who is running Ion, where, and on what version?\n\nThe installation and host view: how many machines are reporting, how many engine installs each carries (several headless instances can share one host), which engine and extension versions are deployed where, and what each host spends. All panels honor the dashboard time picker except **Host last-seen**, a liveness detector with a fixed 24h lookback so a quiet host stays visible.\n\n| Related | Dashboard |\n|---|---|\n| Landing | [Ion Overview](/d/ion-overview) |\n| Per-user view | [Ion Users](/d/ion-users) |\n| Cost detail | [Ion Cost](/d/ion-cost) |';

export function fleetDashboard(): Dashboard {
  const panels = [
    text(1, { h: 4, w: 24, x: 0, y: 0 }, INTRO),
    stat({
      id: 2,
      title: 'Hosts reporting',
      gridPos: { h: 4, w: 4, x: 0, y: 4 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: fixed(), mappings: [], noValue: 'telemetry off' },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: distinctLabelCount('host', HOST_PIPE, '$__range') }],
    }),
    stat({
      id: 3,
      title: 'Installs',
      description: 'Distinct install_id values — engine installations, which can outnumber hosts when headless instances share a machine.',
      gridPos: { h: 4, w: 4, x: 4, y: 4 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: fixed(), mappings: [], noValue: 'telemetry off' },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: distinctLabelCount('install_id', HOST_PIPE, '$__range') }],
    }),
    stat({
      id: 4,
      title: 'Engine versions in fleet',
      description: 'Distinct engine version strings reporting in the window. More than one is version drift — see the drift table below for who is behind.',
      gridPos: { h: 4, w: 4, x: 8, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'orange', value: 2 },
            { color: 'red', value: 3 },
          ]),
          mappings: [],
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: distinctLabelCount('version', HOST_PIPE, '$__range') }],
    }),
    stat({
      id: 5,
      title: 'Fleet spend',
      gridPos: { h: 4, w: 4, x: 12, y: 4 },
      fieldConfig: {
        defaults: { unit: 'currencyUSD', decimals: 4, color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: fixed(), mappings: [], links: link('Ion Cost', '/d/ion-cost'), noValue: 'telemetry off' },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: totalSpend(HOST_PIPE, '$__range') }],
    }),
    stat({
      id: 6,
      title: 'Fleet errors',
      description: 'Telemetry events carrying a non-empty payload_error. Ops-log ERROR lines carry no host identity, so this is the per-host error signal.',
      gridPos: { h: 4, w: 4, x: 16, y: 4 },
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
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: errorEventsBy([], HOST_PIPE, '$__range') }],
    }),
    stat({
      id: 7,
      title: 'Host last-seen (min)',
      description: 'Minutes since the most recent telemetry event per host. Fixed 24h lookback (liveness detector): a host whose engine stopped reporting climbs while the others stay near zero.',
      gridPos: { h: 4, w: 4, x: 20, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'm',
          decimals: 1,
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'orange', value: 5 },
            { color: 'red', value: 60 },
          ]),
          mappings: [],
        },
        overrides: [],
      },
      // Per-series tiles: one labeled cell per host (same pattern as the
      // overview ingest-freshness panel).
      options: {
        ...statOptions('background'),
        textMode: 'value_and_name',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
      },
      targets: [{ e: hostLastSeenMinutes('24h'), legend: '{{host}}' }],
    }),
    row(20, 'Installations and versions', 8),
    bargauge({
      id: 8,
      title: 'Installs per host',
      description: 'Distinct install_id count per host. More than one means several engine instances (e.g. headless daemons) share the machine.',
      gridPos: { h: 8, w: 8, x: 0, y: 9 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'orange', value: 2 },
          ]),
        },
        overrides: [],
      },
      options: { orientation: 'horizontal', reduceOptions: { calcs: ['lastNotNull'] }, displayMode: 'gradient', showUnfilled: true },
      targets: [{ e: installsPerHost('$__range'), legend: '{{host}}' }],
    }),
    table({
      id: 9,
      title: 'Version drift',
      description: 'Every host / install / engine-version combination reporting in the window, with its event count. Two rows for one install means it upgraded mid-window.',
      gridPos: { h: 8, w: 16, x: 8, y: 9 },
      mode: 'instant',
      fieldConfig: { defaults: { unit: 'short', custom: { align: 'auto', displayMode: 'auto' } }, overrides: [] },
      options: { footer: { show: false }, sortBy: [{ displayName: 'Events', desc: true }] },
      transformations: [
        { id: 'organize', options: { renameByName: { host: 'Host', install_id: 'Install', version: 'Engine version', Value: 'Events' } } },
      ],
      targets: [
        { e: activityBy(['host', 'install_id', 'version'], HOST_PIPE, '$__range'), legend: '{{host}} / {{install_id}} / {{version}}' },
      ],
    }),
    table({
      id: 10,
      title: 'Extension versions by host',
      description: 'Which extension versions are deployed where, from run.complete attribution. Runs without an extension are excluded.',
      gridPos: { h: 8, w: 12, x: 0, y: 17 },
      mode: 'instant',
      fieldConfig: { defaults: { unit: 'short', custom: { align: 'auto', displayMode: 'auto' } }, overrides: [] },
      options: { footer: { show: false }, sortBy: [{ displayName: 'Runs', desc: true }] },
      transformations: [
        { id: 'organize', options: { renameByName: { host: 'Host', context_extension: 'Extension', context_extension_version: 'Version', Value: 'Runs' } } },
      ],
      targets: [
        {
          e: kindCountBy('run.complete', ['host', 'context_extension', 'context_extension_version'], HOST_PIPE, '$__range', ' | context_extension=~".+"'),
          legend: '{{host}} / {{context_extension}} v{{context_extension_version}}',
        },
      ],
    }),
    bargauge({
      id: 11,
      title: 'Spend by host',
      gridPos: { h: 8, w: 12, x: 12, y: 17 },
      fieldConfig: { defaults: { unit: 'currencyUSD', decimals: 4 }, overrides: [] },
      options: { orientation: 'horizontal', reduceOptions: { calcs: ['sum'] }, displayMode: 'gradient', showUnfilled: true },
      targets: [{ e: spendBy(['host'], HOST_PIPE, '$__range'), legend: '{{host}}' }],
    }),
    row(30, 'Usage over time', 25),
    timeseries({
      id: 12,
      title: 'Runs by host over time',
      gridPos: { h: 8, w: 12, x: 0, y: 26 },
      fieldConfig: bars(60),
      options: legendBottom(),
      targets: [{ e: runsBy(['host'], HOST_PIPE, '$__interval'), legend: '{{host}}' }],
    }),
    timeseries({
      id: 13,
      title: 'Spend by host over time',
      gridPos: { h: 8, w: 12, x: 12, y: 26 },
      fieldConfig: {
        defaults: { unit: 'currencyUSD', custom: { drawStyle: 'bars', fillOpacity: 60, stacking: { mode: 'normal', group: 'A' } } },
        overrides: [],
      },
      options: legendBottom(),
      targets: [{ e: spendBy(['host'], HOST_PIPE, '$__interval'), legend: '{{host}}' }],
    }),
    timeseries({
      id: 14,
      title: 'Activity by host',
      description: 'All telemetry events per interval, grouped by host — the fleet utilization pulse.',
      gridPos: { h: 8, w: 12, x: 0, y: 34 },
      fieldConfig: bars(60),
      options: legendBottom(),
      targets: [{ e: activityBy(['host'], HOST_PIPE, '$__interval'), legend: '{{host}}' }],
    }),
    timeseries({
      id: 15,
      title: 'Errors by host over time',
      description: 'Telemetry events with a non-empty payload_error, per interval and host.',
      gridPos: { h: 8, w: 12, x: 12, y: 34 },
      fieldConfig: bars(70),
      options: legendBottom(),
      targets: [{ e: errorEventsBy(['host'], HOST_PIPE, '$__interval'), legend: '{{host}}' }],
    }),
  ];

  return {
    uid: 'ion-fleet',
    title: 'Ion Fleet',
    description: 'Ion fleet — who is running Ion, where, and on what version?',
    tags: ['ion', 'fleet'],
    schemaVersion: 39,
    version: 1,
    refresh: '1m',
    timeFrom: 'now-7d',
    folder: 'fleet',
    file: 'ion-fleet',
    panels,
    templating: [
      // `host` is a parsed JSON field, not an indexed stream label, so
      // label_values() cannot populate a dropdown (same constraint as the
      // extensions pack). Textbox regex defaulting to `.*` matches every host.
      {
        name: 'host',
        label: 'Host',
        description: 'Hostname to scope panels. Accepts regex. Default matches all hosts.',
        type: 'textbox',
        current: { value: '.*' },
        query: '.*',
        hide: 0,
      },
    ],
  };
}
