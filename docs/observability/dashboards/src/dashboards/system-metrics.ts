// Recipe: Ion System Metrics (uid ion-system-metrics-001).
//
// How busy each device is and what Ion uses on it, charted from the sample
// lines the engine logs every 30 s, one line per device (the `host` label
// Alloy stamps on every line). The Device and User dropdowns every dashboard
// carries scope it to part of the fleet. Works with telemetry off. The OTLP
// metrics export carries the engine's figures to a metrics store instead;
// this dashboard is the zero-config view.

import type { Dashboard } from '../dashboard.ts';
import { stat, timeseries } from '../panels.ts';
import { engineSample, engineRoleSample, devicesReporting } from '../queries-system-metrics.ts';

const line = (unit: string, max?: number) => ({
  defaults: { unit, ...(max !== undefined ? { max, min: 0 } : {}), custom: { lineWidth: 2, fillOpacity: 10 } },
  overrides: [],
});
const legend = () => ({
  tooltip: { mode: 'multi', sort: 'none' },
  legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
});

export function systemMetricsDashboard(): Dashboard {
  const panels = [
    stat({
      id: 9,
      title: 'Devices reporting',
      description: 'Devices that logged a System Metrics sample in the time range, within the Device and User filters.',
      gridPos: { h: 4, w: 24, x: 0, y: 0 },
      fieldConfig: { defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, noValue: 'none' }, overrides: [] },
      options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, orientation: 'auto', textMode: 'auto', colorMode: 'value', graphMode: 'none' },
      targets: [{ e: devicesReporting('$__range') }],
    }),
    timeseries({
      id: 2,
      title: 'Host CPU in use',
      description: 'Share of all host CPUs in use since the previous sample, 0..1; steal time counts as busy. Source: engine.jsonl tag=sysmetrics fields.host_cpu_utilization.',
      gridPos: { h: 8, w: 12, x: 0, y: 4 },
      fieldConfig: line('percentunit', 1),
      options: legend(),
      targets: [{ e: engineSample('fields_host_cpu_utilization'), legend: '{{host_name}}' }],
    }),
    timeseries({
      id: 3,
      title: 'Host memory available and disk free',
      description: 'Memory available to new work (inside a limited container, the limit less its use), and free space on the volume holding the engine\'s data (systemMetrics.diskPath, default ~/.ion). Source: engine.jsonl fields.host_memory_available_bytes, host_disk_free_bytes.',
      gridPos: { h: 8, w: 12, x: 12, y: 4 },
      fieldConfig: line('bytes'),
      options: legend(),
      targets: [
        { e: engineSample('fields_host_memory_available_bytes'), legend: 'memory {{host_name}}' },
        { e: engineSample('fields_host_disk_free_bytes'), legend: 'disk {{host_name}}', refId: 'B' },
      ],
    }),
    timeseries({
      id: 4,
      title: 'CPU by engine process role, selected devices',
      description: 'Summed CPU of each role in the engine\'s own process tree, added up across the selected devices; 100 = one full core. Pick one device to see one machine. Source: engine.jsonl fields.<role>_cpu_percent.',
      gridPos: { h: 8, w: 12, x: 0, y: 12 },
      fieldConfig: line('percent'),
      options: legend(),
      targets: ['engine', 'extension', 'mcp', 'backend', 'tool'].map((role, i) => ({
        e: engineRoleSample(`fields_${role}_cpu_percent`),
        legend: role,
        ...(i > 0 ? { refId: String.fromCharCode(65 + i) } : {}),
      })),
    }),
    timeseries({
      id: 5,
      title: 'Memory by engine process role, selected devices',
      description: 'Summed resident memory of each role in the engine\'s process tree, added up across the selected devices. Source: engine.jsonl fields.<role>_rss_bytes.',
      gridPos: { h: 8, w: 12, x: 12, y: 12 },
      fieldConfig: line('bytes'),
      options: legend(),
      targets: ['engine', 'extension', 'mcp', 'backend', 'tool'].map((role, i) => ({
        e: engineRoleSample(`fields_${role}_rss_bytes`),
        legend: role,
        ...(i > 0 ? { refId: String.fromCharCode(65 + i) } : {}),
      })),
    }),
  ];

  return {
    uid: 'ion-system-metrics-001',
    title: 'Ion System Metrics',
    description: 'Host load and every engine process, from the sample lines the engine logs every 30 s. Works with telemetry off.',
    tags: ['ion', 'system-metrics', 'resources'],
    schemaVersion: 38,
    version: 1,
    graphTooltip: 1,
    refresh: '30s',
    timeFrom: 'now-6h',
    folder: 'reliability',
    file: 'ion-system-metrics',
    panels,
    annotations: [],
  };
}
