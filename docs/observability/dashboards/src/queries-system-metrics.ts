// System Metrics and Device Metrics, charted from logs.
//
// Each process writes one INFO sample line per background interval (30 s)
// with every number as a flat field, so these queries need nothing but the
// log pipeline Alloy already runs, and work with telemetry off:
//
//   engine.jsonl   tag=sysmetrics      msg="system metrics sample" (or "HIGH MEMORY")
//                  (engine/internal/sysmetrics/sampler.go SampleLogFields)
//   server.jsonl   tag=system-metrics  msg="system metrics sample"
//                  (server/src/system-metrics/publisher.ts serverSampleLogFields)
//   desktop.jsonl  tag=device-metrics  msg="device metrics sample" / "idle repaint detected"
//                  (desktop/src/main/device-metrics/sampler.ts deviceSampleLogFields)
//
// Custom fields sit under `fields`, which `| json` flattens to `fields_<name>`.
// A field that was not measured is omitted, never zero, so `!= ""` drops it.

import type { Expr, Window } from './types.ts';
import { windowedStat, accumulation, registerQuery } from './queries.ts';

const ENGINE = '{service_name="ion-engine", event_name=""} | json | tag="sysmetrics" | msg=~"system metrics sample|HIGH MEMORY"';
const SERVER = '{service_name="ion-server", event_name=""} | json | tag="system-metrics" | msg="system metrics sample"';
const DEVICE = '{service_name="ion-desktop", event_name=""} | json | tag="device-metrics" | msg="device metrics sample"';

// One series per device: `host` is the Alloy identity label every line
// carries, so a fleet charts as one line per machine.
function sampleStat(selector: string, field: string, window: Window): Expr {
  return windowedStat(`avg by (host_name) (avg_over_time(${selector} | ${field} != "" | unwrap ${field} [${window}]))`, window);
}

/** A host or engine-runtime figure off the engine's sample line, per device. */
export const engineSample = (field: string, window: Window = '5m'): Expr => sampleStat(ENGINE, field, window);

/** The server's own process figures off its sample line, per device. */
export const serverSample = (field: string, window: Window = '5m'): Expr => sampleStat(SERVER, field, window);

/** Studio's own processes (Device Metrics) off the desktop sample line, per device. */
export const deviceSample = (field: string, window: Window = '5m'): Expr => sampleStat(DEVICE, field, window);

/** A per-role engine figure summed across the selected devices. */
export const engineRoleSample = (field: string, window: Window = '5m'): Expr =>
  windowedStat(`sum(avg by (host_name) (avg_over_time(${ENGINE} | ${field} != "" | unwrap ${field} [${window}])))`, window);

/** Devices that logged a System Metrics sample in the window. */
export const devicesReporting = (window: Window): Expr =>
  accumulation(`count(sum by (host_name) (count_over_time(${ENGINE} [${window}])))`, window);

/** Idle-repaint warnings: Studio's GPU helper or a renderer busy while nobody looked. */
export const idleRepaintCount = (): Expr =>
  accumulation(
    'sum by (host_name) (count_over_time({service_name="ion-desktop", event_name=""} | json | tag="device-metrics" | msg="idle repaint detected" [$__interval]))',
    '$__interval',
  );

// Named for the generated reference doc (queries.md).
registerQuery(
  'Host CPU in use (from logs)',
  'Share of all host CPUs in use, averaged over the window, from the engine\'s 30 s INFO sample line ' +
    '(tag=sysmetrics). Works with telemetry off. Swap the field for any other flat sample field: ' +
    '`fields_host_memory_available_bytes`, `fields_host_disk_free_bytes`, `fields_<role>_cpu_percent`, ' +
    '`fields_<role>_rss_bytes`, `fields_heap_bytes`, `fields_goroutines`.',
  engineSample('fields_host_cpu_utilization'),
);
registerQuery(
  'Studio GPU helper GPU (from logs)',
  'GPU time of Ion Studio\'s GPU helper as a share of wall time (100 = one GPU fully busy), from the ' +
    'desktop\'s Device Metrics sample line. macOS only; the field is absent, not zero, elsewhere.',
  deviceSample('fields_gpu_helper_gpu_percent'),
);
registerQuery(
  'Idle-repaint warnings (from logs)',
  'Count of `idle repaint detected` WARN lines: Studio\'s GPU helper or a renderer busy while no Studio ' +
    'window had focus or the machine was idle.',
  idleRepaintCount(),
);

/**
 * PromQL for the OTLP metrics export (`telemetry.otel.metrics`). The same
 * expressions run against the local Prometheus and an Azure Monitor
 * workspace. OTel instrument names become Prometheus names with the unit as
 * a suffix (`ion.host.cpu.utilization` → `ion_host_cpu_utilization_ratio`).
 */
export const SYSTEM_METRICS_PROMQL: ReadonlyArray<{ name: string; expr: string; commentary: string }> = [
  { name: 'Host CPU in use', expr: 'avg by (host_name) (ion_host_cpu_utilization_ratio)', commentary: 'Share of all host CPUs in use, per machine.' },
  { name: 'Host memory in use', expr: '1 - (ion_host_memory_available_bytes / ion_host_memory_limit_bytes)', commentary: 'Memory in use against the container limit, or physical memory when none applies.' },
  { name: 'Disk free', expr: 'ion_host_disk_free_bytes', commentary: 'Free space on the volume holding the engine\'s data.' },
  { name: 'CPU cores by process role', expr: 'sum by (role) (ion_process_cpu_utilization)', commentary: 'Cores in use by each role of the engine\'s process tree.' },
  { name: 'Resident memory by process role', expr: 'sum by (role) (ion_process_memory_rss_bytes)', commentary: 'Resident memory of each role of the engine\'s process tree.' },
  { name: 'Engine heap and sessions', expr: 'ion_engine_heap_bytes', commentary: 'Go heap in use; `ion_engine_sessions` and `ion_engine_goroutines` sit beside it.' },
  { name: 'Samples observed per minute', expr: 'rate(ion_system_metrics_samples_total[5m]) * 60', commentary: 'How many System Metrics samples each export observed; zero means the engine stopped sampling.' },
];
