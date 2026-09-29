// Recipe: Ion System Metrics (uid ion-system-metrics-001).
//
// How busy each device is and what Ion uses on it, charted from the sample
// lines each process logs every 30 s, one line per device (the `host` label
// Alloy stamps on every line). The Device and User dropdowns every dashboard
// carries scope it to part of the fleet. Works with telemetry off. The OTLP
// metrics export carries the engine's figures to a metrics store instead;
// this dashboard is the zero-config view, and the only one that sees
// Studio's own Device Metrics, which never leave the machine.

import type { Dashboard } from '../dashboard.ts';
import { text, stat, timeseries } from '../panels.ts';
import { engineSample, engineRoleSample, serverSample, deviceSample, idleRepaintCount, devicesReporting } from '../queries-system-metrics.ts';

const line = (unit: string, max?: number) => ({
  defaults: { unit, ...(max !== undefined ? { max, min: 0 } : {}), custom: { lineWidth: 2, fillOpacity: 10 } },
  overrides: [],
});
const legend = () => ({
  tooltip: { mode: 'multi', sort: 'none' },
  legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
});

const INTRO =
  '## Ion System Metrics\n\nEvery device and every Ion process on it, from the sample line each one logs every 30 s. Charts draw **one line per device**; use the **Device** and **User** dropdowns to narrow the fleet. **Engine** lines carry the host (CPU, memory, disk) and each engine process role; the **server** line carries the Studio server\'s own process; the **desktop** line carries Studio\'s own Electron processes, including GPU time on macOS.\n\nA GPU figure is missing, not zero, where it was not measured. For a fleet, alerting, or Application Insights, use the OTLP metrics export instead (see the observability README, "Signals and where they go").';

export function systemMetricsDashboard(): Dashboard {
  const panels = [
    { ...text(1, { h: 4, w: 24, x: 0, y: 0 }, INTRO), datasource: undefined },
    stat({
      id: 9,
      title: 'Devices reporting',
      description: 'Devices that logged a System Metrics sample in the time range, within the Device and User filters.',
      gridPos: { h: 4, w: 24, x: 0, y: 4 },
      fieldConfig: { defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, noValue: 'none' }, overrides: [] },
      options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, orientation: 'auto', textMode: 'auto', colorMode: 'value', graphMode: 'none' },
      targets: [{ e: devicesReporting('$__range') }],
    }),
    timeseries({
      id: 2,
      title: 'Host CPU in use',
      description: 'Share of all host CPUs in use since the previous sample, 0..1; steal time counts as busy. Source: engine.jsonl tag=sysmetrics fields.host_cpu_utilization.',
      gridPos: { h: 8, w: 12, x: 0, y: 8 },
      fieldConfig: line('percentunit', 1),
      options: legend(),
      targets: [{ e: engineSample('fields_host_cpu_utilization'), legend: '{{host_name}}' }],
    }),
    timeseries({
      id: 3,
      title: 'Host memory available and disk free',
      description: 'Memory available to new work (inside a limited container, the limit less its use), and free space on the volume holding the engine\'s data (systemMetrics.diskPath, default ~/.ion). Source: engine.jsonl fields.host_memory_available_bytes, host_disk_free_bytes.',
      gridPos: { h: 8, w: 12, x: 12, y: 8 },
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
      gridPos: { h: 8, w: 12, x: 0, y: 16 },
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
      gridPos: { h: 8, w: 12, x: 12, y: 16 },
      fieldConfig: line('bytes'),
      options: legend(),
      targets: ['engine', 'extension', 'mcp', 'backend', 'tool'].map((role, i) => ({
        e: engineRoleSample(`fields_${role}_rss_bytes`),
        legend: role,
        ...(i > 0 ? { refId: String.fromCharCode(65 + i) } : {}),
      })),
    }),
    timeseries({
      id: 6,
      title: 'Studio server process CPU',
      description: 'The Ion Studio Server\'s own CPU (100 = one core). Its resident memory is fields.server_rss_bytes on the same line. Source: server.jsonl tag=system-metrics fields.server_cpu_percent.',
      gridPos: { h: 8, w: 12, x: 0, y: 24 },
      fieldConfig: line('percent'),
      options: legend(),
      targets: [
        { e: serverSample('fields_server_cpu_percent'), legend: '{{host_name}}' },
      ],
    }),
    timeseries({
      id: 7,
      title: 'Studio processes: CPU and GPU',
      description: 'Ion Studio\'s own Electron processes on this device: all of them, the GPU helper, and the renderer. GPU time is measured on macOS only. Source: desktop.jsonl tag=device-metrics.',
      gridPos: { h: 8, w: 12, x: 12, y: 24 },
      fieldConfig: line('percent'),
      options: legend(),
      targets: [
        { e: deviceSample('fields_studio_cpu_percent'), legend: 'Studio CPU {{host_name}}' },
        { e: deviceSample('fields_gpu_helper_gpu_percent'), legend: 'GPU helper GPU {{host_name}}', refId: 'B' },
        { e: deviceSample('fields_renderer_cpu_percent'), legend: 'renderer CPU {{host_name}}', refId: 'C' },
      ],
    }),
    timeseries({
      id: 8,
      title: 'Idle-repaint warnings',
      description: 'Times Studio\'s GPU helper or a renderer stayed busy while no Studio window had focus or the machine was idle: the sign of an animation that never stops repainting. Limits are Device settings (idleRepaint* in desktop.json). Source: desktop.jsonl msg="idle repaint detected".',
      gridPos: { h: 8, w: 24, x: 0, y: 32 },
      fieldConfig: line('short'),
      options: legend(),
      targets: [{ e: idleRepaintCount(), legend: '{{host_name}}' }],
    }),
  ];

  return {
    uid: 'ion-system-metrics-001',
    title: 'Ion System Metrics',
    description: 'Host load and every Ion process, from the sample lines each process logs every 30 s. Works with telemetry off. Studio\'s Device Metrics appear only here: they never leave the device.',
    tags: ['ion', 'system-metrics', 'resources', 'gpu'],
    schemaVersion: 38,
    version: 1,
    graphTooltip: 1,
    refresh: '30s',
    timeFrom: 'now-6h',
    folder: 'reliability',
    file: 'ion-system-metrics',
    panels,
    annotations: [
      {
        name: 'Idle repaint',
        expr: '{service_name="ion-desktop", event_name=""} | json | tag="device-metrics" | msg="idle repaint detected"',
        iconColor: 'orange',
        step: '60s',
        titleFormat: '{{host_name}} {{fields_process_name}} gpu={{fields_gpu_percent}} cpu={{fields_cpu_percent}}',
      },
    ],
  };
}
