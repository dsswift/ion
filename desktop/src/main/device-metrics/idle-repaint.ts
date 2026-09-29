/**
 * Idle-repaint detection: Studio's GPU helper or a renderer staying busy while
 * nobody is looking at Studio. That is the sign of an animation that keeps
 * repainting: pulse, shimmer, spinners, a blur that never settles. It pegs
 * the GPU on a high-refresh display and drains a laptop battery.
 *
 * One WARN per episode, once the process has stayed busy for the whole
 * duration while idle; one INFO when it settles. The limits are opinions, so
 * they are Device settings (`idleRepaint*` in desktop.json).
 */
import type { DeviceMetricsSample, DeviceProcess } from '@ion/shared/types-device-metrics'

export interface IdleRepaintThresholds {
  gpuPercent: number
  cpuPercent: number
  durationMs: number
}

export const DEFAULT_IDLE_REPAINT: IdleRepaintThresholds = { gpuPercent: 10, cpuPercent: 15, durationMs: 60_000 }

export interface IdleRepaintReport {
  kind: 'started' | 'ended'
  pid: number
  name: string
  gpuPercent: number | null
  cpuPercent: number
  busyForMs: number
  focused: boolean
  systemIdleState: string
}

interface Episode {
  busySince: number
  warned: boolean
}

/** Whether nobody is looking at Studio. */
export function studioIdle(sample: Pick<DeviceMetricsSample, 'focused' | 'systemIdleState'>): boolean {
  return !sample.focused || sample.systemIdleState === 'idle' || sample.systemIdleState === 'locked'
}

function watched(p: DeviceProcess): boolean {
  return p.type === 'gpu' || p.type === 'renderer'
}

function busy(p: DeviceProcess, t: IdleRepaintThresholds): boolean {
  return (p.gpuPercent !== null && p.gpuPercent >= t.gpuPercent) || p.cpuPercent >= t.cpuPercent
}

export class IdleRepaintDetector {
  private readonly episodes = new Map<number, Episode>()

  /** Feed one sample; returns the reports to log (at most one per process). */
  observe(sample: DeviceMetricsSample, t: IdleRepaintThresholds): IdleRepaintReport[] {
    const idle = studioIdle(sample)
    const reports: IdleRepaintReport[] = []
    const seen = new Set<number>()
    for (const p of sample.processes.filter(watched)) {
      seen.add(p.pid)
      const ep = this.episodes.get(p.pid)
      const report = (kind: IdleRepaintReport['kind'], since: number): IdleRepaintReport => ({
        kind, pid: p.pid, name: p.name, gpuPercent: p.gpuPercent, cpuPercent: p.cpuPercent,
        busyForMs: sample.sampledAt - since, focused: sample.focused, systemIdleState: sample.systemIdleState,
      })
      if (idle && busy(p, t)) {
        if (!ep) {
          this.episodes.set(p.pid, { busySince: sample.sampledAt, warned: false })
        } else if (!ep.warned && sample.sampledAt - ep.busySince >= t.durationMs) {
          ep.warned = true
          reports.push(report('started', ep.busySince))
        }
        continue
      }
      if (ep) {
        if (ep.warned) reports.push(report('ended', ep.busySince))
        this.episodes.delete(p.pid)
      }
    }
    for (const pid of [...this.episodes.keys()]) if (!seen.has(pid)) this.episodes.delete(pid)
    return reports
  }
}

/** Read the thresholds from Device settings, falling back to the defaults. */
export function thresholdsFromSettings(settings: Record<string, unknown>): IdleRepaintThresholds {
  const num = (key: string, fallback: number): number => {
    const v = settings[key]
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
  }
  return {
    gpuPercent: num('idleRepaintGpuPercent', DEFAULT_IDLE_REPAINT.gpuPercent),
    cpuPercent: num('idleRepaintCpuPercent', DEFAULT_IDLE_REPAINT.cpuPercent),
    durationMs: num('idleRepaintSeconds', DEFAULT_IDLE_REPAINT.durationMs / 1000) * 1000,
  }
}
