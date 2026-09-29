/**
 * The Device Metrics sampler: Studio's own processes, their GPU time, and the
 * idle-repaint check. Every 30 s in the background, every second while the
 * Environment page's panel watches. Samples go to desktop.jsonl and to this
 * device's own Studio window, never to a server.
 */
import type { DeviceMetricsSample, DeviceProcess } from '@ion/shared/types-device-metrics'
import { mapAppMetrics, type AppProcessMetric } from './app-metrics'
import { DarwinGpuReader } from './gpu-darwin'
import { IdleRepaintDetector, thresholdsFromSettings, type IdleRepaintThresholds } from './idle-repaint'

export const BACKGROUND_INTERVAL_MS = 30_000
export const WATCHED_INTERVAL_MS = 1_000

export interface DeviceMetricsDeps {
  appMetrics: () => AppProcessMetric[]
  /** GPU % per pid, or null when this platform has no reader. */
  gpu: { sample(pids: ReadonlySet<number>, now: number): Promise<Map<number, number | null>> } | null
  focused: () => boolean
  systemIdleState: () => string
  thresholds: () => IdleRepaintThresholds
  publish: (sample: DeviceMetricsSample) => void
  log: (level: 'debug' | 'info' | 'warn', msg: string, fields: Record<string, unknown>) => void
  now?: () => number
}

/** The GPU reader for this platform: macOS today; null (not measured) elsewhere. */
export function platformGpuReader(platform: NodeJS.Platform = process.platform): DeviceMetricsDeps['gpu'] {
  return platform === 'darwin' ? new DarwinGpuReader() : null
}

export { thresholdsFromSettings }

export class DeviceMetricsSampler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private watchers = 0
  private latestSample: DeviceMetricsSample | null = null
  private lastInfoAt = 0
  private running = false
  private readonly idleRepaint = new IdleRepaintDetector()

  constructor(private readonly deps: DeviceMetricsDeps) {}

  latest(): DeviceMetricsSample | null {
    return this.latestSample
  }

  intervalMs(): number {
    return this.watchers > 0 ? WATCHED_INTERVAL_MS : BACKGROUND_INTERVAL_MS
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.deps.log('info', 'device metrics sampler started', { background_interval_ms: BACKGROUND_INTERVAL_MS, gpu_measured: this.deps.gpu !== null })
    void this.tick()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** A panel opened (`on`) or closed. Returns the latest sample. */
  watch(on: boolean): DeviceMetricsSample | null {
    const before = this.intervalMs()
    this.watchers = Math.max(0, this.watchers + (on ? 1 : -1))
    const after = this.intervalMs()
    this.deps.log('info', 'device metrics watch changed', { on, watchers: this.watchers, interval_ms: after })
    if (before !== after && this.running) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      void this.tick()
    }
    return this.latestSample
  }

  private schedule(): void {
    if (!this.running) return
    this.timer = setTimeout(() => void this.tick(), this.intervalMs())
  }

  async tick(): Promise<DeviceMetricsSample | null> {
    const now = (this.deps.now ?? Date.now)()
    let sample: DeviceMetricsSample | null = null
    try {
      const processes = mapAppMetrics(this.deps.appMetrics())
      if (this.deps.gpu) {
        try {
          const gpu = await this.deps.gpu.sample(new Set(processes.map((p) => p.pid)), now)
          for (const p of processes) p.gpuPercent = gpu.get(p.pid) ?? null
        } catch (err) {
          this.deps.log('warn', 'device gpu read failed; gpu reported as not measured', { error: String(err) })
        }
      }
      sample = {
        sampledAt: now,
        intervalMs: this.intervalMs(),
        processes,
        focused: this.deps.focused(),
        systemIdleState: this.deps.systemIdleState(),
      }
      this.latestSample = sample
      this.logSample(sample, now)
      for (const r of this.idleRepaint.observe(sample, this.deps.thresholds())) {
        const fields = {
          pid: r.pid, process_name: r.name, gpu_percent: r.gpuPercent, cpu_percent: r.cpuPercent,
          busy_for_ms: r.busyForMs, focused: r.focused, system_idle_state: r.systemIdleState,
        }
        if (r.kind === 'started') this.deps.log('warn', 'idle repaint detected', fields)
        else this.deps.log('info', 'idle repaint ended', fields)
      }
      this.deps.publish(sample)
    } catch (err) {
      this.deps.log('warn', 'device metrics sample failed', { error: String(err) })
    }
    this.schedule()
    return sample
  }

  /** Every sample at DEBUG; one per background interval at INFO, as flat fields. */
  private logSample(sample: DeviceMetricsSample, now: number): void {
    const info = now - this.lastInfoAt >= BACKGROUND_INTERVAL_MS
    if (info) this.lastInfoAt = now
    this.deps.log(info ? 'info' : 'debug', 'device metrics sample', deviceSampleLogFields(sample))
  }
}

/** Flat numeric fields for LogQL `unwrap`: Studio totals plus the GPU helper and the renderer. */
export function deviceSampleLogFields(sample: DeviceMetricsSample): Record<string, unknown> {
  const sum = (ps: DeviceProcess[], f: (p: DeviceProcess) => number) => ps.reduce((s, p) => s + f(p), 0)
  const of = (type: DeviceProcess['type']) => sample.processes.filter((p) => p.type === type)
  const gpuHelper = of('gpu')
  const renderers = of('renderer')
  const gpuOf = (ps: DeviceProcess[]) => (ps.some((p) => p.gpuPercent !== null) ? sum(ps, (p) => p.gpuPercent ?? 0) : null)
  const fields: Record<string, unknown> = {
    interval_ms: sample.intervalMs,
    studio_process_count: sample.processes.length,
    studio_cpu_percent: sum(sample.processes, (p) => p.cpuPercent),
    studio_rss_bytes: sum(sample.processes, (p) => p.rssBytes),
    gpu_helper_cpu_percent: sum(gpuHelper, (p) => p.cpuPercent),
    gpu_helper_rss_bytes: sum(gpuHelper, (p) => p.rssBytes),
    renderer_cpu_percent: sum(renderers, (p) => p.cpuPercent),
    renderer_rss_bytes: sum(renderers, (p) => p.rssBytes),
    focused: sample.focused,
    system_idle_state: sample.systemIdleState,
  }
  // GPU fields are omitted, not zeroed, when GPU time was not measured, so a
  // chart never shows a false 0.
  const gpuFields: Array<[string, number | null]> = [
    ['studio_gpu_percent', gpuOf(sample.processes)],
    ['gpu_helper_gpu_percent', gpuOf(gpuHelper)],
    ['renderer_gpu_percent', gpuOf(renderers)],
  ]
  for (const [key, value] of gpuFields) if (value !== null) fields[key] = value
  return fields
}
