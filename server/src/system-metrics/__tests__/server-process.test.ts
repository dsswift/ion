/**
 * The server's own sample carries how late its event loop ran: the p50 and
 * p99 of the loop-delay histogram since the previous sample, as the flat
 * `server_event_loop_p50_ms` / `server_event_loop_p99_ms` log fields the
 * Ion Performance dashboard charts.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

import { ServerProcessSampler, EVENT_LOOP_DELAY_RESOLUTION_MS, type LoopDelayHistogram } from '../server-process'
import { mergeEnvironmentMetrics } from '../store'
import { serverSampleLogFields } from '../publisher'
import type { SystemMetricsSample } from '@ion/shared/types-system-metrics'

/** A histogram whose percentiles a test sets, in nanoseconds like the real one. */
function fakeHistogram(values: { p50: number; p99: number; max: number; count: number }): LoopDelayHistogram & { resets: number; enabled: boolean } {
  const h = {
    resets: 0,
    enabled: false,
    count: values.count,
    max: values.max,
    percentile: (p: number) => (p === 50 ? values.p50 : values.p99),
    reset: () => { h.resets += 1 },
    enable: () => { h.enabled = true; return true },
    disable: () => { h.enabled = false; return true },
  }
  return h as unknown as LoopDelayHistogram & { resets: number; enabled: boolean }
}

const engineSample: SystemMetricsSample = {
  sampledAt: 1, intervalMs: 1000,
  host: { cpuUtilization: 0.1, cpuCount: 8, effectiveCpuCount: 8, memoryTotalBytes: 16_000, memoryAvailableBytes: 4_000, memoryLimitBytes: 0, containerLimited: false, load1: 1, diskPath: '/x', diskTotalBytes: 1_000, diskFreeBytes: 250 },
  processes: [], runtime: { heapBytes: 1, sysBytes: 2, memLimitBytes: 3, goroutines: 4, numGC: 5, sessions: 6 },
}

describe('ServerProcessSampler event-loop delay', () => {
  it('reads the histogram once per sample, takes the resolution tick off, and resets it for the next interval', () => {
    const ms = (n: number): number => (n + EVENT_LOOP_DELAY_RESOLUTION_MS) * 1e6
    const histogram = fakeHistogram({ p50: ms(2), p99: ms(48), max: ms(120), count: 500 })
    const sampler = new ServerProcessSampler(histogram)
    expect(histogram.enabled).toBe(true)
    // The first sample has no full interval behind it.
    expect(sampler.sample(1_000).eventLoopDelay).toBeNull()
    expect(histogram.resets).toBe(1)
    expect(sampler.sample(2_000).eventLoopDelay).toEqual({ p50Ms: 2, p99Ms: 48, maxMs: 120 })
    expect(histogram.resets).toBe(2)
    sampler.dispose()
    expect(histogram.enabled).toBe(false)
  })

  it('reports null when the loop never ticked during the interval', () => {
    const sampler = new ServerProcessSampler(fakeHistogram({ p50: 0, p99: 0, max: 0, count: 0 }))
    sampler.sample(1_000)
    expect(sampler.sample(2_000).eventLoopDelay).toBeNull()
  })

  it('reaches the merged sample and the flat INFO fields the dashboard reads', () => {
    const sampler = new ServerProcessSampler(fakeHistogram({ p50: 13e6, p99: 210e6, max: 300e6, count: 9 }))
    sampler.sample(1_000)
    const merged = mergeEnvironmentMetrics(engineSample, sampler.sample(2_000))
    expect(merged.serverEventLoopDelayP50Ms).toBe(3)
    expect(merged.serverEventLoopDelayP99Ms).toBe(200)
    const fields = serverSampleLogFields(merged, 0)
    expect(fields.server_event_loop_p50_ms).toBe(3)
    expect(fields.server_event_loop_p99_ms).toBe(200)
  })

  it('measures the real loop when no histogram is injected', async () => {
    const sampler = new ServerProcessSampler()
    sampler.sample()
    await new Promise((resolve) => setTimeout(resolve, 60))
    const delay = sampler.sample().eventLoopDelay
    sampler.dispose()
    expect(delay).not.toBeNull()
    expect(delay!.p99Ms).toBeGreaterThanOrEqual(delay!.p50Ms)
  })
})
