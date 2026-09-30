// Recipe: Ion Mobile (uid ion-mobile).
//
// "Which iOS devices are running Ion Remote, on what app version, paired to
// which server?" The per-device view over the iOS OPERATIONAL-LOG stream
// ({service_name="ion-ios", event_name=""}) — NOT the telemetry stream the Fleet pack uses, because
// iOS emits no telemetry. Every iOS log line is the full canonical Ion JSONL
// (the OTLP body carries the complete record since log-egress-otel ships the
// full JSON). Alloy's ion_otlp_unwrap rewrites the Loki line to that JSON body,
// so `| json` extraction works. Device identity fields live under the `fields`
// key:
//   device_id / device_model / app_version / app_build / os_version  — stamped by iOS
//   mdm_device_id / mdm_serial                                        — stamped by iOS (MDM-enrolled)
//   pairing_id / desktop_host                                          — stamped by the server
//
// device_id is the stable per-device hardware identity (UIDevice.identifierForVendor
// UUID) that survives re-pairings. pairing_id is the ECDH channel ID for the
// specific server pairing session. Named json extraction pulls them to top-level
// label names (queries-mobile.ts DEVICE_PIPE) so `by (device_id, ...)` groupings
// resolve. The $device variable scopes by device_model (hardware model, e.g.
// iPhone15,3) rather than a user-assigned name that can change.

import type { Dashboard } from '../dashboard.ts';
import { row, stat, timeseries, bargauge, table, logsTable } from '../panels.ts';
import { stream } from '../queries.ts';
import {
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

export function mobileDashboard(): Dashboard {
  const panels = [
    stat({
      id: 2,
      title: 'Devices reporting',
      gridPos: { h: 4, w: 5, x: 0, y: 0 },
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
      gridPos: { h: 4, w: 5, x: 5, y: 0 },
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
      gridPos: { h: 4, w: 5, x: 10, y: 0 },
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
      gridPos: { h: 4, w: 5, x: 15, y: 0 },
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
      gridPos: { h: 4, w: 4, x: 20, y: 0 },
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
      targets: [{ e: deviceLastSeenMinutes('24h'), legend: '{{device_model}} {{device_id}}' }],
    }),
    row(10, 'Devices, versions, and pairing', 4),
    table({
      id: 11,
      title: 'App version by device',
      description: 'Every device / app-version / OS-version combination reporting in the window, with its line count. Two rows for one device means it upgraded mid-window. MDM columns appear for enrolled devices.',
      gridPos: { h: 8, w: 12, x: 0, y: 5 },
      mode: 'instant',
      fieldConfig: { defaults: { unit: 'short', custom: { align: 'auto', displayMode: 'auto' } }, overrides: [] },
      options: { footer: { show: false }, sortBy: [{ displayName: 'Lines', desc: true }] },
      transformations: [
        {
          id: 'organize',
          options: {
            renameByName: {
              device_id: 'Device ID',
              device_model: 'Model',
              pairing_id: 'Pairing ID',
              mdm_device_id: 'MDM Device ID',
              mdm_serial: 'Serial',
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
          legend: '{{device_model}} ({{device_id}}) {{app_version}}({{app_build}}) iOS {{os_version}}',
        },
      ],
    }),
    table({
      id: 12,
      title: 'Device → server pairing',
      description: 'Every device × desktop_host pair that produced iOS logs in the window. device_id is the stable hardware identity (survives re-pairings); pairing_id is the ECDH channel for the specific session. A device paired to two servers yields two rows; several devices on one server yield several rows for that host. desktop_host matches the telemetry host on the Ion Fleet board.',
      gridPos: { h: 8, w: 12, x: 12, y: 5 },
      mode: 'instant',
      fieldConfig: { defaults: { unit: 'short', custom: { align: 'auto', displayMode: 'auto' } }, overrides: [] },
      options: { footer: { show: false }, sortBy: [{ displayName: 'Lines', desc: true }] },
      transformations: [
        {
          id: 'organize',
          options: {
            renameByName: {
              device_id: 'Device ID',
              device_model: 'Model',
              pairing_id: 'Pairing ID',
              desktop_host: 'Server host',
              mdm_device_id: 'MDM Device ID',
              mdm_serial: 'Serial',
              Value: 'Lines',
            },
          },
        },
      ],
      targets: [
        { e: devicePairingMatrix('$__range'), legend: '{{device_model}} ({{device_id}}) @ {{desktop_host}}' },
      ],
    }),
    bargauge({
      id: 13,
      title: 'Log volume by device',
      gridPos: { h: 8, w: 12, x: 0, y: 13 },
      fieldConfig: { defaults: { unit: 'short' }, overrides: [] },
      options: { orientation: 'horizontal', reduceOptions: { calcs: ['sum'] }, displayMode: 'gradient', showUnfilled: true },
      targets: [{ e: volumeByDevice(['device_id', 'device_model'], '$__range'), legend: '{{device_model}} {{device_id}}' }],
    }),
    bargauge({
      id: 14,
      title: 'Errors by device',
      gridPos: { h: 8, w: 12, x: 12, y: 13 },
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
      targets: [{ e: errorsByDevice(['device_id', 'device_model'], '$__range'), legend: '{{device_model}} {{device_id}}' }],
    }),
    row(20, 'Activity over time', 21),
    timeseries({
      id: 15,
      title: 'Log volume by device over time',
      gridPos: { h: 8, w: 12, x: 0, y: 22 },
      fieldConfig: bars(60),
      options: legendBottom(),
      targets: [{ e: volumeByDevice(['device_id', 'device_model'], '$__interval'), legend: '{{device_model}} {{device_id}}' }],
    }),
    timeseries({
      id: 16,
      title: 'Errors by device over time',
      gridPos: { h: 8, w: 12, x: 12, y: 22 },
      fieldConfig: bars(70),
      options: legendBottom(),
      targets: [{ e: errorsByDevice(['device_id', 'device_model'], '$__interval'), legend: '{{device_model}} {{device_id}}' }],
    }),
    logsTable({
      id: 17,
      title: 'iOS log tail',
      gridPos: { h: 12, w: 24, x: 0, y: 30 },
      target: { e: stream('{service_name="ion-ios", event_name=""} | json device_model="fields.device_model" | __error__="" | device_model=~"$device"') },
    }),
  ];

  return {
    uid: 'ion-mobile',
    title: 'Ion Mobile',
    description: 'Ion mobile — which iOS devices are running Ion, on what version, paired to which server?',
    tags: ['ion', 'mobile'],
    schemaVersion: 39,
    version: 1,
    refresh: '1m',
    timeFrom: 'now-7d',
    folder: 'mobile',
    file: 'ion-mobile',
    panels,
    templating: [
      // device_model is the hardware model identifier (e.g. iPhone15,3) extracted
      // via named json extraction from fields.device_model. label_values() cannot
      // populate a dropdown for extracted fields — textbox regex defaulting to `.*`
      // matches all devices. Use a regex like `iPhone15.*` to scope to a model family.
      {
        name: 'device',
        label: 'Device model',
        description: 'Hardware model identifier regex to scope panels (e.g. `iPhone15,3`, `iPhone15.*`). Default `.*` matches all.',
        type: 'textbox',
        current: { value: '.*' },
        query: '.*',
        hide: 0,
      },
    ],
  };
}
