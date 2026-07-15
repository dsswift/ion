// Recipe: Ion Mobile (uid ion-mobile).
//
// "Which iOS devices are running Ion Remote, on what app version, paired to
// which desktop?" The per-device view over the iOS OPERATIONAL-LOG stream
// ({component="ios"}) — NOT the telemetry stream the Fleet pack uses, because
// iOS emits no telemetry. Every iOS log line is the full canonical Ion JSONL
// (the OTLP body carries the complete record since log-egress-otel ships the
// full JSON). Alloy's ion_otlp_unwrap rewrites the Loki line to that JSON body,
// so `| json` extraction works. Device identity fields live under the `fields`
// key: device_model / app_version / app_build / os_version (stamped by iOS)
// and device_id / device_name / desktop_host (stamped by the paired desktop at
// persist time). Named json extraction pulls them to top-level label names
// (queries-mobile.ts DEVICE_PIPE) so `by (device_name, ...)` groupings resolve.
//
// The device↔desktop pairing table is the headline capability: it separates
// several devices paired to one desktop, and one device paired to several
// desktops, by (device_id, desktop_host) pair.

import type { Dashboard } from '../dashboard.ts';
import { row, text, stat, timeseries, bargauge, table, logs } from '../panels.ts';
import { stream } from '../queries.ts';
import {
  DEVICE_PIPE,
  distinctDeviceField,
  iosLinesCount,
  iosErrorCount,
  volumeByDevice,
  errorsByDevice,
  appVersionByDevice,
  devicePairingMatrix,
  deviceLastSeenMinutes,
} from '../queries-mobile.ts';

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

const INTRO =
  '## Which iOS devices are running Ion, on what version, paired to which desktop?\n\nThe per-device mobile view over the **iOS log stream** (`{component="ios"}`). iOS emits no telemetry, so this pack does not appear on [Ion Fleet](/d/ion-fleet) — it reads the operational logs the paired desktop collects. Every line carries device identity: model / OS / app version+build (stamped by iOS) and device id / name / desktop host (stamped by the desktop). The **device→desktop pairing** table below is the "which device connected where" matrix. `desktop_host` matches the telemetry `host`, so a pairing row cross-references the Fleet board for the same machine.\n\nAll panels honor the dashboard time picker except **Device last-seen**, a liveness detector with a fixed 24h lookback so a quiet device stays visible.\n\n| Related | Dashboard |\n|---|---|\n| Landing | [Ion Overview](/d/ion-overview) |\n| Desktop/host view | [Ion Fleet](/d/ion-fleet) |\n| Live logs | [Ion Live Logs](/d/ion-logs) |';

export function mobileDashboard(): Dashboard {
  const panels = [
    text(1, { h: 4, w: 24, x: 0, y: 0 }, INTRO),
    stat({
      id: 2,
      title: 'Devices reporting',
      gridPos: { h: 4, w: 5, x: 0, y: 4 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: fixed(), mappings: [], noValue: 'no iOS logs' },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: distinctDeviceField('device_id', '$__range') }],
    }),
    stat({
      id: 3,
      title: 'App versions in use',
      description: 'Distinct app_version strings across the iOS fleet in the window. More than one is version drift — see the drift table below for which device is behind.',
      gridPos: { h: 4, w: 5, x: 5, y: 4 },
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
      targets: [{ e: distinctDeviceField('app_version', '$__range') }],
    }),
    stat({
      id: 4,
      title: 'iOS log lines',
      gridPos: { h: 4, w: 5, x: 10, y: 4 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: fixed(), mappings: [], noValue: 'no iOS logs' },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: iosLinesCount('$__range') }],
    }),
    stat({
      id: 5,
      title: 'iOS errors',
      gridPos: { h: 4, w: 5, x: 15, y: 4 },
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
      targets: [{ e: iosErrorCount('$__range') }],
    }),
    stat({
      id: 6,
      title: 'Device last-seen (min)',
      description: 'Minutes since the most recent iOS log line per device. Fixed 24h lookback (liveness detector): a device whose logs stopped arriving climbs while the others stay near zero.',
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
      // Per-series tiles: one labeled cell per device (same pattern as the
      // fleet host last-seen panel).
      options: {
        ...statOptions('background'),
        textMode: 'value_and_name',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
      },
      targets: [{ e: deviceLastSeenMinutes('24h'), legend: '{{device_name}}' }],
    }),
    row(10, 'Devices, versions, and pairing', 8),
    table({
      id: 11,
      title: 'App version by device',
      description: 'Every device / app-version / OS-version combination reporting in the window, with its line count. Two rows for one device means it upgraded mid-window.',
      gridPos: { h: 8, w: 12, x: 0, y: 9 },
      mode: 'instant',
      fieldConfig: { defaults: { unit: 'short', custom: { align: 'auto', displayMode: 'auto' } }, overrides: [] },
      options: { footer: { show: false }, sortBy: [{ displayName: 'Lines', desc: true }] },
      transformations: [
        {
          id: 'organize',
          options: {
            renameByName: {
              device_id: 'Device ID',
              device_name: 'Device',
              app_version: 'App version',
              app_build: 'Build',
              os_version: 'iOS',
              Value: 'Lines',
            },
          },
        },
      ],
      targets: [
        {
          e: appVersionByDevice('$__range'),
          legend: '{{device_name}} {{app_version}}({{app_build}}) iOS {{os_version}}',
        },
      ],
    }),
    table({
      id: 12,
      title: 'Device → desktop pairing',
      description: 'Every device × desktop_host pair that produced iOS logs in the window. A device paired to two desktops yields two rows; several devices on one desktop yield several rows for that host. desktop_host matches the telemetry host on the Ion Fleet board.',
      gridPos: { h: 8, w: 12, x: 12, y: 9 },
      mode: 'instant',
      fieldConfig: { defaults: { unit: 'short', custom: { align: 'auto', displayMode: 'auto' } }, overrides: [] },
      options: { footer: { show: false }, sortBy: [{ displayName: 'Lines', desc: true }] },
      transformations: [
        {
          id: 'organize',
          options: {
            renameByName: {
              device_id: 'Device ID',
              device_name: 'Device',
              desktop_host: 'Desktop host',
              Value: 'Lines',
            },
          },
        },
      ],
      targets: [
        { e: devicePairingMatrix('$__range'), legend: '{{device_name}} @ {{desktop_host}}' },
      ],
    }),
    bargauge({
      id: 13,
      title: 'Log volume by device',
      gridPos: { h: 8, w: 12, x: 0, y: 17 },
      fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
      options: { orientation: 'horizontal', reduceOptions: { calcs: ['sum'] }, displayMode: 'gradient', showUnfilled: true },
      targets: [{ e: volumeByDevice(['device_name'], '$__range'), legend: '{{device_name}}' }],
    }),
    bargauge({
      id: 14,
      title: 'Errors by device',
      gridPos: { h: 8, w: 12, x: 12, y: 17 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'orange', value: 1 },
          ]),
        },
        overrides: [],
      },
      options: { orientation: 'horizontal', reduceOptions: { calcs: ['sum'] }, displayMode: 'gradient', showUnfilled: true },
      targets: [{ e: errorsByDevice(['device_name'], '$__range'), legend: '{{device_name}}' }],
    }),
    row(20, 'Activity over time', 25),
    timeseries({
      id: 15,
      title: 'Log volume by device over time',
      gridPos: { h: 8, w: 12, x: 0, y: 26 },
      fieldConfig: bars(60),
      options: legendBottom(),
      targets: [{ e: volumeByDevice(['device_name'], '$__interval'), legend: '{{device_name}}' }],
    }),
    timeseries({
      id: 16,
      title: 'Errors by device over time',
      gridPos: { h: 8, w: 12, x: 12, y: 26 },
      fieldConfig: bars(70),
      options: legendBottom(),
      targets: [{ e: errorsByDevice(['device_name'], '$__interval'), legend: '{{device_name}}' }],
    }),
    logs({
      id: 17,
      title: 'iOS log tail',
      gridPos: { h: 12, w: 24, x: 0, y: 34 },
      options: {
        showTime: true,
        showLabels: true,
        showCommonLabels: false,
        wrapLogMessage: true,
        prettifyLogMessage: false,
        enableLogDetails: true,
        dedupStrategy: 'none',
        sortOrder: 'Descending',
      },
      target: { e: stream('{component="ios"} | json device_name="fields.device_name" | __error__="" | device_name=~"$device"') },
    }),
  ];

  return {
    uid: 'ion-mobile',
    title: 'Ion Mobile',
    description: 'Ion mobile — which iOS devices are running Ion, on what version, paired to which desktop?',
    tags: ['ion', 'mobile'],
    schemaVersion: 39,
    version: 1,
    refresh: '1m',
    timeFrom: 'now-7d',
    folder: 'mobile',
    file: 'ion-mobile',
    panels,
    templating: [
      // device_name is extracted via named json extraction from fields.device_name
      // (not an indexed stream label). label_values() cannot populate a dropdown
      // for extracted fields — textbox regex defaulting to `.*` matches every device.
      {
        name: 'device',
        label: 'Device',
        description: 'Device name to scope panels. Accepts regex. Default matches all devices.',
        type: 'textbox',
        current: { value: '.*' },
        query: '.*',
        hide: 0,
      },
    ],
  };
}
