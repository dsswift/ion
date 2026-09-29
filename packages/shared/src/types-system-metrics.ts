/**
 * System Metrics: the engine's `engine_system_metrics` payload, mirrored from
 * Go (`engine/internal/types/system_metrics.go`) and pinned field-for-field by
 * the contract-sync test.
 *
 * Every sample is a COMPLETE snapshot. A consumer replaces its copy and never
 * merges; a process absent from `processes` is no longer running. A sample
 * never carries a command line.
 */

import type { TelemetryHealthState } from './types-telemetry-health'

/** The fixed set of process roles. The only label OTLP metrics carry. */
export type SystemMetricsRole = 'engine' | 'extension' | 'mcp' | 'backend' | 'tool'

export interface SystemMetricsHost {
  /** Share of all CPUs in use since the previous sample, 0..1. Null on the first sample. */
  cpuUtilization: number | null
  cpuCount: number
  /** CPU count, or the container's CPU quota when a cgroup limits it. */
  effectiveCpuCount: number
  memoryTotalBytes: number
  /** Memory available to new work; inside a limited container, limit minus use. */
  memoryAvailableBytes: number
  /** The container's memory limit, or 0 when none applies. */
  memoryLimitBytes: number
  containerLimited: boolean
  /** One-minute load average; null where the OS has none (Windows). */
  load1: number | null
  diskPath: string
  diskTotalBytes: number
  diskFreeBytes: number
}

export interface SystemMetricsProcess {
  pid: number
  /** Start time (Unix ms). With pid, identifies the process across samples. */
  startTimeMs: number
  role: SystemMetricsRole
  /** Extension name, MCP server name, or executable base name. Never a command line. */
  name: string
  /** CPU use since the previous sample, 100 = one full core. Null on a process's first sample. */
  cpuPercent: number | null
  cpuTimeMs: number
  rssBytes: number
}

export interface SystemMetricsRuntime {
  heapBytes: number
  sysBytes: number
  memLimitBytes: number
  goroutines: number
  numGC: number
  sessions: number
}

export interface SystemMetricsSample {
  /** Unix ms. */
  sampledAt: number
  /** The sampling interval in effect when this sample was taken. */
  intervalMs: number
  host: SystemMetricsHost
  processes: SystemMetricsProcess[]
  runtime: SystemMetricsRuntime
}

/**
 * A process role in an Environment's System Metrics: the engine's roles plus
 * `server`, the Ion Studio Server process, which the server samples itself
 * because it is not the engine's child.
 */
export type EnvironmentSystemMetricsRole = SystemMetricsRole | 'server'

export interface EnvironmentSystemMetricsProcess extends Omit<SystemMetricsProcess, 'role'> {
  role: EnvironmentSystemMetricsRole
}

/**
 * One Environment's System Metrics, as the server publishes it on
 * `ion:system-metrics` and in the Studio snapshot: the engine's latest
 * sample with the server's own process merged into `processes`. A complete
 * snapshot; a client replaces its copy.
 */
export interface EnvironmentSystemMetrics {
  sampledAt: number
  intervalMs: number
  host: SystemMetricsHost
  processes: EnvironmentSystemMetricsProcess[]
  runtime: SystemMetricsRuntime
  /** Share of the server's event loop spent busy since its previous sample, 0..1. */
  serverEventLoopUtilization: number | null
}

/** One 10-second bucket of Environment System Metrics history. */
export interface SystemMetricsHistoryBucket {
  /** Bucket start, Unix ms. */
  at: number
  hostCpuAvg: number | null
  hostCpuMax: number | null
  /** Highest memory in use (total or limit, less available) in the bucket. */
  memoryUsedMaxBytes: number
  /** Average CPU of every Ion process together, 100 = one full core. */
  ionCpuAvgPercent: number
  /** Highest resident memory of every Ion process together. */
  ionRssMaxBytes: number
}

/**
 * `environment.systemMetrics.latest`: the newest full sample (null before the
 * first one, or where the server samples nothing) and the delivery health of
 * every telemetry target, read without starting or stopping a watch.
 */
export interface EnvironmentSystemMetricsLatest {
  latest: EnvironmentSystemMetrics | null
  telemetryHealth: TelemetryHealthState[]
}
