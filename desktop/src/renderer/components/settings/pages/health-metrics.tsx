/**
 * health-metrics — the Health page's metrics strip and process rows: host
 * CPU, memory, and disk as three thin meters in one row, the CPU count and
 * load, and a 15-minute CPU sparkline.
 *
 * Nothing here animates: the meters and sparkline are static SVG, redrawn
 * only when a sample arrives. The helpers are carried over from the old
 * System Metrics panel unchanged.
 */
import React from 'react'
import type { EnvironmentSystemMetrics, EnvironmentSystemMetricsProcess, SystemMetricsHistoryBucket } from '@ion/shared/types-system-metrics'
import type { DeviceProcess } from '@ion/shared/types-device-metrics'
import { useColors } from '../../../theme'
import { HISTORY_WINDOW_SEC } from '../environment/system-metrics-client'
import { Chip, KIT, Muted, toneColor } from '../kit'

const ROLE_ORDER = ['engine', 'server', 'studio', 'extension', 'mcp', 'backend', 'tool']

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}

export function pct(v: number | null | undefined): string {
  return v == null ? '—' : `${Math.round(v)}%`
}

export interface ProcessRow {
  key: string
  role: string
  name: string
  cpuPercent: number | null
  rssBytes: number
  gpuPercent?: number | null
}

/** Engine and server first, then Studio, then children by role; heaviest first within a role. */
export function processRows(env: EnvironmentSystemMetricsProcess[], device: DeviceProcess[] | null): ProcessRow[] {
  const rows: ProcessRow[] = env.map((p) => ({ key: `${p.pid}:${p.startTimeMs}`, role: p.role, name: p.name, cpuPercent: p.cpuPercent, rssBytes: p.rssBytes }))
  for (const p of device ?? []) rows.push({ key: `studio:${p.pid}`, role: 'studio', name: p.name, cpuPercent: p.cpuPercent, rssBytes: p.rssBytes, gpuPercent: p.gpuPercent })
  const rank = (role: string): number => { const i = ROLE_ORDER.indexOf(role); return i < 0 ? ROLE_ORDER.length : i }
  return rows.sort((a, b) => rank(a.role) - rank(b.role) || b.rssBytes - a.rssBytes)
}

/** Label, thin bar, value. The bar turns warning at 75% and error at 90%. */
function Meter({ label, fraction, detail }: { label: string; fraction: number | null; detail: string }): React.JSX.Element {
  const colors = useColors()
  const f = fraction == null ? 0 : Math.max(0, Math.min(1, fraction))
  const fill = f >= 0.9 ? toneColor(colors, 'error') : f >= 0.75 ? toneColor(colors, 'warn') : toneColor(colors, 'accent')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: KIT.fontTiny }}>
        <span style={{ color: colors.textTertiary }}>{label}</span>
        <span style={{ color: colors.textPrimary, whiteSpace: 'nowrap' }}>{detail}</span>
      </div>
      <svg aria-label={`${label} ${fraction == null ? 'unknown' : `${Math.round(f * 100)}%`}`} width="100%" height="4" preserveAspectRatio="none" viewBox="0 0 100 4">
        <rect x="0" y="0" width="100" height="4" rx="2" fill={colors.surfaceSecondary} />
        <rect x="0" y="0" width={f * 100} height="4" rx="2" fill={fill} />
      </svg>
    </div>
  )
}

/** A static sparkline of host CPU: pulled buckets, then the live tail. */
export function Sparkline({ history, live }: { history: SystemMetricsHistoryBucket[]; live: Array<{ at: number; value: number }> }): React.JSX.Element | null {
  const colors = useColors()
  const lastBucket = history.length > 0 ? history[history.length - 1].at : 0
  const points = [
    ...history.filter((b) => b.hostCpuAvg != null).map((b) => ({ at: b.at, value: b.hostCpuAvg as number })),
    ...live.filter((p) => p.at > lastBucket),
  ]
  if (points.length < 2) return null
  const t0 = points[0].at
  const span = Math.max(1, points[points.length - 1].at - t0)
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(((p.at - t0) / span) * 100).toFixed(2)},${(30 - p.value * 30).toFixed(2)}`).join(' ')
  return (
    <svg aria-label="host cpu history" width="100%" height="28" viewBox="0 0 100 30" preserveAspectRatio="none">
      <path d={d} fill="none" stroke={colors.accent} strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** The host's CPU, memory, and disk in one row, with CPU count, load, and the history line under it. */
export function MetricsStrip({ m, history, live }: { m: EnvironmentSystemMetrics; history: SystemMetricsHistoryBucket[]; live: Array<{ at: number; value: number }> }): React.JSX.Element {
  const ceiling = m.host.memoryLimitBytes > 0 ? m.host.memoryLimitBytes : m.host.memoryTotalBytes
  const used = Math.max(0, ceiling - m.host.memoryAvailableBytes)
  const diskUsed = m.host.diskTotalBytes - m.host.diskFreeBytes
  const cpus = m.host.effectiveCpuCount || m.host.cpuCount
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: `10px ${KIT.inset}px` }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 16 }}>
        <Meter label="CPU" fraction={m.host.cpuUtilization} detail={pct(m.host.cpuUtilization == null ? null : m.host.cpuUtilization * 100)} />
        <Meter label="Memory" fraction={ceiling > 0 ? used / ceiling : null} detail={`${formatBytes(used)} of ${formatBytes(ceiling)}`} />
        <Meter label="Disk" fraction={m.host.diskTotalBytes > 0 ? diskUsed / m.host.diskTotalBytes : null} detail={`${formatBytes(m.host.diskFreeBytes)} free`} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Muted>{cpus % 1 === 0 ? cpus : cpus.toFixed(1)} CPUs{m.host.load1 != null ? ` · load ${m.host.load1.toFixed(2)}` : ''} · host CPU, last {HISTORY_WINDOW_SEC / 60} minutes</Muted>
        {m.host.containerLimited && <Chip>container limit</Chip>}
      </div>
      <Sparkline history={history} live={live} />
    </div>
  )
}
