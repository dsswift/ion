import { describe, it, expect, vi } from 'vitest'
import type { DeviceMetricsSample, DeviceProcess } from '@ion/shared/types-device-metrics'
import { mapAppMetrics } from './app-metrics'
import { parseIoregGpuTime, gpuPercentFromTotals, DarwinGpuReader } from './gpu-darwin'
import { IdleRepaintDetector, thresholdsFromSettings, DEFAULT_IDLE_REPAINT } from './idle-repaint'
import { DeviceMetricsSampler, deviceSampleLogFields, BACKGROUND_INTERVAL_MS, WATCHED_INTERVAL_MS } from './sampler'

// Shape of `ioreg -r -c IOAccelerator -w 0 -l`, trimmed: an accelerator,
// then user clients each naming their creator. Two clients belong to pid 101.
const IOREG = `
+-o AGXAcceleratorG15X  <class AGXAcceleratorG15X>
    {
      "PerformanceStatistics" = {"Device Utilization %"=3}
    }
  +-o AGXDeviceUserClient  <class AGXDeviceUserClient>
      {
        "AppUsage" = ({"API"="Metal","lastSubmittedTime"=1,"accumulatedGPUTime"=1000000},{"API"="Metal","lastSubmittedTime"=2,"accumulatedGPUTime"=2000000})
        "IOUserClientCreator" = "pid 101, Ion Helper (GPU)"
      }
  +-o AGXDeviceUserClient  <class AGXDeviceUserClient>
      {
        "AppUsage" = ({"API"="Metal","lastSubmittedTime"=3,"accumulatedGPUTime"=500000})
        "IOUserClientCreator" = "pid 101, Ion Helper (GPU)"
      }
  +-o AGXDeviceUserClient  <class AGXDeviceUserClient>
      {
        "AppUsage" = ({"API"="Metal","lastSubmittedTime"=4,"accumulatedGPUTime"=999999999})
        "IOUserClientCreator" = "pid 555, WindowServer"
      }
  +-o AGXDeviceUserClient  <class AGXDeviceUserClient>
      {
        "AppUsage" = ()
        "IOUserClientCreator" = "pid 102, Ion Helper (Renderer)"
      }
`

describe('parseIoregGpuTime', () => {
  it('sums every client and entry of a pid and keeps only the pids asked for', () => {
    const totals = parseIoregGpuTime(IOREG, new Set([101, 102]))
    expect(totals.get(101)).toBe(3_500_000)
    expect(totals.get(102)).toBe(0)
    expect(totals.has(555)).toBe(false) // another app's GPU use is never kept
  })
})

describe('gpuPercentFromTotals', () => {
  it('is the GPU time over wall time', () => {
    expect(gpuPercentFromTotals(0, 60_000_000, 2_000)).toBeCloseTo(3)
  })
  it('is null with no baseline, no elapsed time, or a restarted counter', () => {
    expect(gpuPercentFromTotals(undefined, 5, 1_000)).toBeNull()
    expect(gpuPercentFromTotals(5, 10, 0)).toBeNull()
    expect(gpuPercentFromTotals(10_000, 5, 1_000)).toBeNull()
  })
})

describe('DarwinGpuReader', () => {
  it('reports GPU % since the previous read', async () => {
    const outputs = [IOREG, IOREG.replace('accumulatedGPUTime"=500000', 'accumulatedGPUTime"=10500000')]
    const reader = new DarwinGpuReader(async () => outputs.shift()!)
    const first = await reader.sample(new Set([101]), 1_000)
    expect(first.get(101)).toBeNull()
    const second = await reader.sample(new Set([101]), 2_000)
    expect(second.get(101)).toBeCloseTo(1) // 10 ms of GPU in 1 s
  })
})

describe('mapAppMetrics', () => {
  it('labels Electron process types and converts KB to bytes', () => {
    const rows = mapAppMetrics([
      { pid: 1, type: 'Browser', cpu: { percentCPUUsage: 4 }, memory: { workingSetSize: 100 } },
      { pid: 2, type: 'GPU', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 50 } },
      { pid: 3, type: 'Tab', cpu: { percentCPUUsage: 9 }, memory: { workingSetSize: 200 } },
      { pid: 4, type: 'Utility', serviceName: 'network.mojom.NetworkService', cpu: { percentCPUUsage: 0 }, memory: { workingSetSize: 10 } },
    ])
    expect(rows.map((r) => [r.type, r.name])).toEqual([['browser', 'main'], ['gpu', 'gpu'], ['renderer', 'renderer'], ['utility', 'network']])
    expect(rows[0].rssBytes).toBe(102_400)
    expect(rows.every((r) => r.gpuPercent === null)).toBe(true)
  })
})

function deviceSample(at: number, gpu: DeviceProcess, focused = false, systemIdleState = 'active'): DeviceMetricsSample {
  return { sampledAt: at, intervalMs: 1000, processes: [gpu], focused, systemIdleState }
}
const gpuProc = (gpuPercent: number | null, cpuPercent = 0): DeviceProcess => ({ pid: 7, type: 'gpu', name: 'gpu', cpuPercent, rssBytes: 1, gpuPercent })

describe('IdleRepaintDetector', () => {
  const t = { gpuPercent: 10, cpuPercent: 15, durationMs: 60_000 }

  it('fires once after the duration, then logs the recovery', () => {
    const d = new IdleRepaintDetector()
    expect(d.observe(deviceSample(0, gpuProc(40)), t)).toEqual([])
    expect(d.observe(deviceSample(30_000, gpuProc(40)), t)).toEqual([])
    const started = d.observe(deviceSample(60_000, gpuProc(40)), t)
    expect(started).toEqual([expect.objectContaining({ kind: 'started', pid: 7, busyForMs: 60_000 })])
    expect(d.observe(deviceSample(90_000, gpuProc(40)), t)).toEqual([]) // once per episode
    expect(d.observe(deviceSample(120_000, gpuProc(1)), t)).toEqual([expect.objectContaining({ kind: 'ended' })])
  })

  it('does not fire while a Studio window is focused and the machine active', () => {
    const d = new IdleRepaintDetector()
    for (let at = 0; at <= 120_000; at += 30_000) expect(d.observe(deviceSample(at, gpuProc(90), true), t)).toEqual([])
  })

  it('fires when focused but the machine is idle, and on CPU alone', () => {
    const d = new IdleRepaintDetector()
    d.observe(deviceSample(0, gpuProc(null, 50), true, 'idle'), t)
    expect(d.observe(deviceSample(60_000, gpuProc(null, 50), true, 'idle'), t)).toHaveLength(1)
  })

  it('does not fire for a spike shorter than the duration', () => {
    const d = new IdleRepaintDetector()
    d.observe(deviceSample(0, gpuProc(40)), t)
    d.observe(deviceSample(30_000, gpuProc(1)), t)
    expect(d.observe(deviceSample(60_000, gpuProc(40)), t)).toEqual([])
  })

  it('reads its limits from Device settings, with defaults for bad values', () => {
    expect(thresholdsFromSettings({})).toEqual(DEFAULT_IDLE_REPAINT)
    expect(thresholdsFromSettings({ idleRepaintGpuPercent: 25, idleRepaintCpuPercent: 'x', idleRepaintSeconds: 5 })).toEqual({ gpuPercent: 25, cpuPercent: 15, durationMs: 5_000 })
  })
})

describe('DeviceMetricsSampler', () => {
  function build(now: { t: number }) {
    const logs: Array<[string, string, Record<string, unknown>]> = []
    const published: DeviceMetricsSample[] = []
    const sampler = new DeviceMetricsSampler({
      appMetrics: () => [{ pid: 2, type: 'GPU', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 1 } }],
      gpu: { sample: async (pids) => new Map([...pids].map((p) => [p, 5])) },
      focused: () => true,
      systemIdleState: () => 'active',
      thresholds: () => DEFAULT_IDLE_REPAINT,
      publish: (s) => published.push(s),
      log: (level, msg, fields) => logs.push([level, msg, fields]),
      now: () => now.t,
    })
    return { sampler, logs, published }
  }

  it('speeds up while watched and slows down when the watch ends', () => {
    const { sampler } = build({ t: 0 })
    expect(sampler.intervalMs()).toBe(BACKGROUND_INTERVAL_MS)
    sampler.watch(true)
    expect(sampler.intervalMs()).toBe(WATCHED_INTERVAL_MS)
    sampler.watch(false)
    expect(sampler.intervalMs()).toBe(BACKGROUND_INTERVAL_MS)
    sampler.watch(false) // never below zero watchers
    expect(sampler.intervalMs()).toBe(BACKGROUND_INTERVAL_MS)
  })

  it('publishes locally and logs one INFO sample per background interval', async () => {
    vi.useFakeTimers()
    try {
      const now = { t: 100_000 }
      const { sampler, logs, published } = build(now)
      await sampler.tick()
      now.t += 1_000
      await sampler.tick()
      sampler.stop()
      expect(published).toHaveLength(2)
      expect(published[0].processes[0].gpuPercent).toBe(5)
      const levels = logs.filter(([, msg]) => msg === 'device metrics sample').map(([level]) => level)
      expect(levels).toEqual(['info', 'debug'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('omits GPU log fields when GPU was not measured, so no chart shows a false 0', () => {
    const measured = deviceSampleLogFields(deviceSample(0, gpuProc(12)))
    expect(measured.gpu_helper_gpu_percent).toBe(12)
    const unmeasured = deviceSampleLogFields(deviceSample(0, gpuProc(null)))
    expect('gpu_helper_gpu_percent' in unmeasured).toBe(false)
    expect(unmeasured.gpu_helper_cpu_percent).toBe(0)
  })
})
