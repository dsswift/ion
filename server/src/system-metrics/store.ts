/**
 * The Environment's System Metrics: the engine's latest sample merged with the
 * server's own process, and a one-hour history in 10-second buckets.
 */
import type {
  EnvironmentSystemMetrics,
  SystemMetricsHistoryBucket,
  SystemMetricsSample,
} from '@ion/shared/types-system-metrics'
import type { ServerProcessSample } from './server-process'

export const HISTORY_BUCKET_MS = 10_000
export const HISTORY_WINDOW_MS = 60 * 60 * 1000
const HISTORY_MAX_BUCKETS = HISTORY_WINDOW_MS / HISTORY_BUCKET_MS

/** Merge one engine sample with the server's own process. */
export function mergeEnvironmentMetrics(engine: SystemMetricsSample, server: ServerProcessSample): EnvironmentSystemMetrics {
  return {
    sampledAt: engine.sampledAt,
    intervalMs: engine.intervalMs,
    host: engine.host,
    processes: [...engine.processes, server.process],
    runtime: engine.runtime,
    serverEventLoopUtilization: server.eventLoopUtilization,
    serverEventLoopDelayP50Ms: server.eventLoopDelay?.p50Ms ?? null,
    serverEventLoopDelayP99Ms: server.eventLoopDelay?.p99Ms ?? null,
  }
}

/** Memory in use on the host, or inside the container when one limits it. */
export function memoryUsedBytes(m: Pick<EnvironmentSystemMetrics, 'host'>): number {
  const ceiling = m.host.memoryLimitBytes > 0 ? m.host.memoryLimitBytes : m.host.memoryTotalBytes
  return Math.max(0, ceiling - m.host.memoryAvailableBytes)
}

interface Accumulator {
  at: number
  cpuSum: number
  cpuCount: number
  cpuMax: number | null
  memMax: number
  ionCpuSum: number
  samples: number
  ionRssMax: number
}

/** Holds the latest merged sample and the bucketed history. */
export class SystemMetricsStore {
  private latestValue: EnvironmentSystemMetrics | null = null
  private readonly buckets: SystemMetricsHistoryBucket[] = []
  private open: Accumulator | null = null

  latest(): EnvironmentSystemMetrics | null {
    return this.latestValue
  }

  record(m: EnvironmentSystemMetrics): void {
    this.latestValue = m
    const at = m.sampledAt - (m.sampledAt % HISTORY_BUCKET_MS)
    if (this.open && this.open.at !== at) this.close()
    if (!this.open) {
      this.open = { at, cpuSum: 0, cpuCount: 0, cpuMax: null, memMax: 0, ionCpuSum: 0, samples: 0, ionRssMax: 0 }
    }
    const acc = this.open
    const cpu = m.host.cpuUtilization
    if (cpu !== null) {
      acc.cpuSum += cpu
      acc.cpuCount++
      acc.cpuMax = acc.cpuMax === null ? cpu : Math.max(acc.cpuMax, cpu)
    }
    acc.memMax = Math.max(acc.memMax, memoryUsedBytes(m))
    acc.ionCpuSum += m.processes.reduce((sum, p) => sum + (p.cpuPercent ?? 0), 0)
    acc.ionRssMax = Math.max(acc.ionRssMax, m.processes.reduce((sum, p) => sum + p.rssBytes, 0))
    acc.samples++
  }

  /** Buckets inside the last `windowMs`, oldest first, including the open one. */
  history(windowMs: number, now: number = Date.now()): SystemMetricsHistoryBucket[] {
    const since = now - Math.min(Math.max(windowMs, 0), HISTORY_WINDOW_MS)
    const all = this.open ? [...this.buckets, toBucket(this.open)] : [...this.buckets]
    return all.filter((b) => b.at + HISTORY_BUCKET_MS > since)
  }

  private close(): void {
    if (!this.open) return
    this.buckets.push(toBucket(this.open))
    if (this.buckets.length > HISTORY_MAX_BUCKETS) this.buckets.splice(0, this.buckets.length - HISTORY_MAX_BUCKETS)
    this.open = null
  }
}

function toBucket(acc: Accumulator): SystemMetricsHistoryBucket {
  return {
    at: acc.at,
    hostCpuAvg: acc.cpuCount > 0 ? acc.cpuSum / acc.cpuCount : null,
    hostCpuMax: acc.cpuMax,
    memoryUsedMaxBytes: acc.memMax,
    ionCpuAvgPercent: acc.samples > 0 ? acc.ionCpuSum / acc.samples : 0,
    ionRssMaxBytes: acc.ionRssMax,
  }
}
