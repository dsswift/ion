import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

import type { SystemMetricsSample } from '@ion/shared/types-system-metrics'
import {
  SystemMetricsPublisher,
  BACKGROUND_ENGINE_INTERVAL_MS,
  LIVE_ENGINE_INTERVAL_MS,
  THIN_SUMMARY_INTERVAL_MS,
  thinSummary,
  type SystemMetricsConnection,
  type SystemMetricsEngineLink,
} from '../publisher'
import { SystemMetricsStore, HISTORY_BUCKET_MS, HISTORY_WINDOW_MS, mergeEnvironmentMetrics } from '../store'

function sample(at: number, cpu: number | null = 0.5): SystemMetricsSample {
  return {
    sampledAt: at,
    intervalMs: 1000,
    host: {
      cpuUtilization: cpu, cpuCount: 8, effectiveCpuCount: 8, memoryTotalBytes: 16_000, memoryAvailableBytes: 4_000,
      memoryLimitBytes: 0, containerLimited: false, load1: 1, diskPath: '/x', diskTotalBytes: 1_000, diskFreeBytes: 250,
    },
    processes: [{ pid: 10, startTimeMs: 1, role: 'engine', name: 'ion', cpuPercent: 20, cpuTimeMs: 5, rssBytes: 100 }],
    runtime: { heapBytes: 1, sysBytes: 2, memLimitBytes: 3, goroutines: 4, numGC: 5, sessions: 6, gcPauseP99Ms: 0, allocRateBytesPerS: 0, schedLatencyP99Ms: 0 },
  }
}

function fakeEngine() {
  const requests: Array<{ cmd: string; payload?: Record<string, unknown> }> = []
  let onEvent: ((key: string, event: { type?: string; systemMetrics?: SystemMetricsSample }) => void) | undefined
  let onReconnect: (() => void) | undefined
  const link: SystemMetricsEngineLink = {
    on: ((ev: string, cb: never) => {
      if (ev === 'event') onEvent = cb
      else onReconnect = cb
    }) as SystemMetricsEngineLink['on'],
    request: async <T,>(cmd: string, payload?: Record<string, unknown>) => {
      requests.push({ cmd, payload })
      return { ok: true, data: (cmd === 'get_system_metrics' ? sample(1) : { intervalMs: payload?.intervalMs }) as T }
    },
  }
  return {
    link,
    requests,
    emit: (s: SystemMetricsSample) => onEvent?.('', { type: 'engine_system_metrics', systemMetrics: s }),
    reconnect: () => onReconnect?.(),
    watchIntervals: () => requests.filter((r) => r.cmd === 'system_metrics_watch').map((r) => r.payload?.intervalMs),
  }
}

function fakeConn(id: string, view: 'mirror' | 'thin' = 'mirror') {
  const frames: Array<{ channel: string; payload: unknown }> = []
  const conn: SystemMetricsConnection & { frames: typeof frames } = {
    id, view, isClosed: false, frames,
    send: (f) => { frames.push({ channel: f.channel, payload: f.payload }); return true },
  }
  return conn
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('SystemMetricsPublisher', () => {
  let engine: ReturnType<typeof fakeEngine>
  let pub: SystemMetricsPublisher

  beforeEach(async () => {
    engine = fakeEngine()
    pub = new SystemMetricsPublisher(engine.link)
    pub.install()
    await flush()
  })

  it('keeps a background engine watch and speeds it up for the first Studio watcher', async () => {
    expect(engine.watchIntervals()).toEqual([BACKGROUND_ENGINE_INTERVAL_MS])
    const a = fakeConn('a')
    const b = fakeConn('b')
    pub.watch(a, true)
    pub.watch(b, true)
    await flush()
    expect(engine.watchIntervals()).toEqual([BACKGROUND_ENGINE_INTERVAL_MS, LIVE_ENGINE_INTERVAL_MS])
    pub.watch(a, false)
    await flush()
    expect(engine.watchIntervals()).toHaveLength(2) // b still watches
    pub.forget('b') // disconnect
    await flush()
    expect(engine.watchIntervals()).toEqual([BACKGROUND_ENGINE_INTERVAL_MS, LIVE_ENGINE_INTERVAL_MS, BACKGROUND_ENGINE_INTERVAL_MS])
  })

  it('a thin watcher alone does not speed the engine up', async () => {
    pub.watch(fakeConn('phone', 'thin'), true)
    await flush()
    expect(engine.watchIntervals()).toEqual([BACKGROUND_ENGINE_INTERVAL_MS])
  })

  it('restores the watch after an engine reconnect', async () => {
    pub.watch(fakeConn('a'), true)
    await flush()
    engine.reconnect()
    await flush()
    expect(engine.watchIntervals().at(-1)).toBe(LIVE_ENGINE_INTERVAL_MS)
    expect(engine.requests.filter((r) => r.cmd === 'get_system_metrics')).toHaveLength(2)
  })

  it('sends merged samples only to watching Studio connections, with the server process added', () => {
    const watcher = fakeConn('w')
    const bystander = fakeConn('b')
    pub.watch(watcher, true)
    engine.emit(sample(2_000))
    expect(bystander.frames).toHaveLength(0)
    const frame = watcher.frames.find((f) => f.channel === 'ion:system-metrics')
    const payload = frame?.payload as { processes: Array<{ role: string }> }
    expect(payload.processes.map((p) => p.role)).toEqual(['engine', 'server'])
  })

  it('sends a thin watcher a summary at most every ten seconds', () => {
    const phone = fakeConn('p', 'thin')
    pub.watch(phone, true) // sends the latest at once
    const before = phone.frames.length
    engine.emit(sample(3_000))
    const now = Date.now()
    pub.ingest(sample(4_000), now)
    expect(phone.frames.length).toBe(before)
    pub.ingest(sample(5_000), now + THIN_SUMMARY_INTERVAL_MS)
    expect(phone.frames.length).toBe(before + 1)
    const last = phone.frames.at(-1)!
    expect(last.channel).toBe('studio:thin-event')
    expect((last.payload as { type: string }).type).toBe('desktop_system_metrics')
  })

  it('drops a closed connection on the next sample', async () => {
    const conn = fakeConn('gone')
    pub.watch(conn, true)
    conn.isClosed = true
    engine.emit(sample(6_000))
    expect(pub.watcherCount()).toBe(0)
  })
})

describe('thinSummary', () => {
  it('reports fractions of the container limit when one applies', () => {
    const m = mergeEnvironmentMetrics(
      { ...sample(1), host: { ...sample(1).host, memoryLimitBytes: 8_000, memoryAvailableBytes: 2_000 } },
      { process: { pid: 1, startTimeMs: 1, role: 'server', name: 'ion-server', cpuPercent: null, cpuTimeMs: 0, rssBytes: 0 }, eventLoopUtilization: null, eventLoopDelay: null },
    )
    expect(thinSummary(m)).toEqual({ type: 'desktop_system_metrics', cpuUtilization: 0.5, memoryUsedFraction: 0.75, diskFreeFraction: 0.25, sampledAt: 1 })
  })
})

describe('SystemMetricsStore history', () => {
  const server = { process: { pid: 1, startTimeMs: 1, role: 'server' as const, name: 'ion-server', cpuPercent: 10, cpuTimeMs: 0, rssBytes: 50 }, eventLoopUtilization: 0.1, eventLoopDelay: { p50Ms: 1, p99Ms: 4, maxMs: 9 } }

  it('buckets samples by ten seconds with average and maximum', () => {
    const store = new SystemMetricsStore()
    store.record(mergeEnvironmentMetrics(sample(0, 0.2), server))
    store.record(mergeEnvironmentMetrics(sample(5_000, 0.6), server))
    store.record(mergeEnvironmentMetrics(sample(HISTORY_BUCKET_MS, null), server))
    const buckets = store.history(HISTORY_WINDOW_MS, HISTORY_BUCKET_MS + 1)
    expect(buckets).toHaveLength(2)
    expect(buckets[0].hostCpuAvg).toBeCloseTo(0.4)
    expect(buckets[0].hostCpuMax).toBe(0.6)
    expect(buckets[0].ionRssMaxBytes).toBe(150)
    expect(buckets[1].hostCpuAvg).toBeNull()
  })

  it('keeps at most one hour of buckets', () => {
    const store = new SystemMetricsStore()
    const n = HISTORY_WINDOW_MS / HISTORY_BUCKET_MS + 20
    for (let i = 0; i < n; i++) store.record(mergeEnvironmentMetrics(sample(i * HISTORY_BUCKET_MS), server))
    const now = n * HISTORY_BUCKET_MS
    expect(store.history(HISTORY_WINDOW_MS * 2, now).length).toBeLessThanOrEqual(HISTORY_WINDOW_MS / HISTORY_BUCKET_MS + 1)
    expect(store.history(60_000, now).length).toBe(6)
  })
})
