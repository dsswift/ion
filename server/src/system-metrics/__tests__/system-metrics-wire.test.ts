/**
 * System Metrics over a real Studio connection: the welcome replays the
 * latest sample and the retained telemetry health, the watch action streams
 * `ion:system-metrics` to the watcher only, and a disconnect ends the watch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../engine/engine-bridge-fs', () => ({
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: true, data: { version: '1.2.3' } })),
  getEnterprisePolicy: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('../../state', () => ({ engineBridge: { connected: true }, deviceFocusMap: new Map(), state: {} }))
vi.mock('../../thin-view/thin-sync', () => ({ sendThinFirstPaint: vi.fn(() => Promise.resolve()), noteThinConnectionClosed: vi.fn() }))

import type { SystemMetricsSample } from '@ion/shared/types-system-metrics'
import { decodeFrame } from '@ion/shared/studio-wire/codec'
import { startHarness, connectLocal, waitOpen, helloAndWelcome, sendFrame, closeSocket, resetConnectionRegistryForTest, type Harness } from '../../protocol/__tests__/harness'
import { _resetPrincipalIndexForTest } from '../../protocol/snapshot'
import { installSystemMetrics } from '../runtime'
import { installTelemetryHealthConsumer, __resetTelemetryHealthForTest, type TelemetryHealthEvent } from '../../engine/telemetry-health'
import type { SystemMetricsPublisher } from '../publisher'

function sample(at: number): SystemMetricsSample {
  return {
    sampledAt: at, intervalMs: 1000,
    host: { cpuUtilization: 0.3, cpuCount: 4, effectiveCpuCount: 4, memoryTotalBytes: 8, memoryAvailableBytes: 4, memoryLimitBytes: 0, containerLimited: false, load1: null, diskPath: '/d', diskTotalBytes: 10, diskFreeBytes: 5 },
    processes: [{ pid: 9, startTimeMs: 1, role: 'engine', name: 'ion', cpuPercent: null, cpuTimeMs: 0, rssBytes: 1 }],
    runtime: { heapBytes: 0, sysBytes: 0, memLimitBytes: 0, goroutines: 1, numGC: 0, sessions: 0 },
  }
}

let harness: Harness
let dataDir: string
let prevDataDir: string | undefined
let emitSample: (s: SystemMetricsSample) => void
let publisher: SystemMetricsPublisher

beforeEach(async () => {
  prevDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-sysmetrics-wire-'))
  process.env.ION_DATA_DIR = dataDir
  let handler: ((key: string, event: { type?: string; systemMetrics?: SystemMetricsSample }) => void) | undefined
  publisher = installSystemMetrics({
    on: ((ev: string, cb: never) => { if (ev === 'event') handler = cb }) as never,
    request: async <T,>(cmd: string) => ({ ok: true, data: (cmd === 'get_system_metrics' ? sample(1) : { intervalMs: 1000 }) as T }),
  })
  emitSample = (s) => handler?.('', { type: 'engine_system_metrics', systemMetrics: s })
  harness = await startHarness()
})

afterEach(async () => {
  await harness.close()
  resetConnectionRegistryForTest()
  _resetPrincipalIndexForTest()
  __resetTelemetryHealthForTest()
  if (prevDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = prevDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

async function connect(clientId: string) {
  const ws = connectLocal(harness)
  await waitOpen(ws)
  const welcome = await helloAndWelcome(ws, { clientId, clientKind: 'desktop' })
  const events: Array<{ channel: string; payload: unknown }> = []
  const results: Array<{ id: string; ok: boolean; value?: unknown }> = []
  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    const frame = decodeFrame(data.toString('utf-8'))
    if (frame.type === 'studio_event') events.push({ channel: frame.channel, payload: frame.payload })
    if (frame.type === 'studio_action_result') results.push(frame as never)
  })
  return { ws, welcome, events, results }
}

const settle = () => new Promise((r) => setTimeout(r, 60))

describe('System Metrics on the Studio wire', () => {
  it('the welcome replays the latest sample and the retained telemetry health', async () => {
    let healthHandler: ((key: string, e: TelemetryHealthEvent) => void) | undefined
    installTelemetryHealthConsumer({ on: (_ev, cb) => { healthHandler = cb } })
    healthHandler?.('', { type: 'engine_telemetry_health', telemetryTarget: 'http', telemetryHealthy: false, telemetryStuck: true })
    emitSample(sample(5_000))

    const { ws, welcome } = await connect('late-desktop')
    expect(welcome.snapshot.systemMetrics?.sampledAt).toBe(5_000)
    expect(welcome.snapshot.systemMetrics?.processes.map((p) => p.role)).toEqual(['engine', 'server'])
    expect(welcome.snapshot.telemetryHealth).toEqual([expect.objectContaining({ target: 'http', healthy: false, stuck: true })])
    await closeSocket(ws)
  })

  it('streams samples to the watcher only, and a disconnect ends the watch', async () => {
    const watcher = await connect('watcher')
    const bystander = await connect('bystander')
    sendFrame(watcher.ws, { type: 'studio_action', id: 'w1', action: 'environment.systemMetrics.watch', args: [{ on: true }] })
    await settle()
    expect(watcher.results.find((r) => r.id === 'w1')?.ok).toBe(true)
    expect(publisher.watcherCount()).toBe(1)

    emitSample(sample(7_000))
    await settle()
    expect(watcher.events.some((e) => e.channel === 'ion:system-metrics')).toBe(true)
    expect(bystander.events.some((e) => e.channel === 'ion:system-metrics')).toBe(false)

    await closeSocket(watcher.ws)
    await settle()
    expect(publisher.watcherCount()).toBe(0)
    await closeSocket(bystander.ws)
  })

  it('history returns buckets for the window asked', async () => {
    const { ws, results } = await connect('history')
    emitSample(sample(Date.now()))
    sendFrame(ws, { type: 'studio_action', id: 'h1', action: 'environment.systemMetrics.history', args: [{ windowSec: 60 }] })
    await settle()
    const value = results.find((r) => r.id === 'h1')?.value as { buckets: unknown[]; windowMs: number }
    expect(value.windowMs).toBe(60_000)
    expect(value.buckets.length).toBeGreaterThan(0)
    await closeSocket(ws)
  })
})
