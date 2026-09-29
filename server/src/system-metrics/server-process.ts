/**
 * The server's own process, sampled by the server: the engine cannot see it,
 * because the server is not the engine's child.
 */
import { performance, type EventLoopUtilization } from 'perf_hooks'
import type { EnvironmentSystemMetricsProcess } from '@ion/shared/types-system-metrics'

export interface ServerProcessSample {
  process: EnvironmentSystemMetricsProcess
  eventLoopUtilization: number | null
}

/** Remembers the previous reading so CPU and event-loop use are per interval. */
export class ServerProcessSampler {
  private prevCpuMs: number | null = null
  private prevAt = 0
  private prevElu: EventLoopUtilization | null = null
  private readonly startTimeMs = Math.round(performance.timeOrigin)

  sample(now: number = Date.now()): ServerProcessSample {
    const usage = process.cpuUsage()
    const cpuTimeMs = Math.round((usage.user + usage.system) / 1000)
    let cpuPercent: number | null = null
    if (this.prevCpuMs !== null && now > this.prevAt && cpuTimeMs >= this.prevCpuMs) {
      cpuPercent = ((cpuTimeMs - this.prevCpuMs) / (now - this.prevAt)) * 100
    }
    this.prevCpuMs = cpuTimeMs
    this.prevAt = now

    const elu = performance.eventLoopUtilization()
    const eventLoopUtilization = this.prevElu ? performance.eventLoopUtilization(elu, this.prevElu).utilization : null
    this.prevElu = elu

    return {
      process: {
        pid: process.pid,
        startTimeMs: this.startTimeMs,
        role: 'server',
        name: 'ion-server',
        cpuPercent,
        cpuTimeMs,
        rssBytes: process.memoryUsage().rss,
      },
      eventLoopUtilization,
    }
  }
}
