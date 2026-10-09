/**
 * The server's own process, sampled by the server: the engine cannot see it,
 * because the server is not the engine's child.
 */
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'perf_hooks'

/** The event-loop delay histogram `monitorEventLoopDelay` returns. */
export type LoopDelayHistogram = ReturnType<typeof monitorEventLoopDelay>
import type { EnvironmentSystemMetricsProcess } from '@ion/shared/types-system-metrics'

/** How late the event loop ran its timers within one sample, in milliseconds. */
export interface EventLoopDelay {
  p50Ms: number
  p99Ms: number
  maxMs: number
}

export interface ServerProcessSample {
  process: EnvironmentSystemMetricsProcess
  eventLoopUtilization: number | null
  /** Null on the first sample, before the histogram has a full interval. */
  eventLoopDelay: EventLoopDelay | null
}

/** The histogram's sampling resolution. Coarser than the loop's own tick, fine enough for a 10 ms stall to register. */
export const EVENT_LOOP_DELAY_RESOLUTION_MS = 10

/** Nanoseconds to whole milliseconds, with the resolution's own tick taken off (a loop that is never late still measures one tick). */
function delayMs(nanos: number): number {
  return Math.max(0, Math.round(nanos / 1e6) - EVENT_LOOP_DELAY_RESOLUTION_MS)
}

/** Remembers the previous reading so CPU and event-loop use are per interval. */
export class ServerProcessSampler {
  private prevCpuMs: number | null = null
  private prevAt = 0
  private prevElu: EventLoopUtilization | null = null
  private readonly startTimeMs = Math.round(performance.timeOrigin)
  /** Started on construction; its distribution is read and reset once per sample. */
  private readonly delays: LoopDelayHistogram
  private sampledOnce = false

  constructor(histogram: LoopDelayHistogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_DELAY_RESOLUTION_MS })) {
    this.delays = histogram
    this.delays.enable()
  }

  /** Stops the histogram. For a process that tears its sampler down (tests). */
  dispose(): void {
    this.delays.disable()
  }

  /** The loop delay distribution since the previous sample, then a fresh one. */
  private takeEventLoopDelay(): EventLoopDelay | null {
    const first = !this.sampledOnce
    this.sampledOnce = true
    const delay = this.delays.count > 0
      ? { p50Ms: delayMs(this.delays.percentile(50)), p99Ms: delayMs(this.delays.percentile(99)), maxMs: delayMs(this.delays.max) }
      : null
    this.delays.reset()
    return first ? null : delay
  }

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
      eventLoopDelay: this.takeEventLoopDelay(),
    }
  }
}
