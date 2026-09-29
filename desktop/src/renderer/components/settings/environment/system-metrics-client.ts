/**
 * The Environment page's System Metrics hooks.
 *
 * - `useEnvironmentSystemMetrics`: watches ONE environment while mounted
 *   (`environment.systemMetrics.watch`), seeds from the watch reply and a
 *   one-time history pull, then replaces its copy with each
 *   `ion:system-metrics` sample. Unmount stops the watch.
 * - `useDeviceMetrics`: this machine's own Studio processes, over device IPC.
 *   Null where there is nothing to measure (a browser tab).
 * - `useTelemetryHealth`: the environment's telemetry delivery health, seeded
 *   from the welcome snapshot's replay and kept current by
 *   `ion:telemetry-health`.
 */
import { useEffect, useState } from 'react'
import type { EnvironmentSystemMetrics, SystemMetricsHistoryBucket } from '@ion/shared/types-system-metrics'
import type { DeviceMetricsSample } from '@ion/shared/types-device-metrics'
import type { TelemetryHealthState } from '@ion/shared/types-telemetry-health'
import { SYSTEM_METRICS_CHANNEL } from '@ion/shared/studio-wire/channels'
import { host, action } from '../../../host/host-instance'
import { onEnvironmentEvent } from './environment-client'
import { rInfo, rWarn } from '../../../rendererLogger'

const TAG = 'system-metrics-panel'
/** The history window the panel draws. */
export const HISTORY_WINDOW_SEC = 15 * 60
/** Samples kept in the renderer to extend the pulled history live. */
const LIVE_HISTORY_MAX = HISTORY_WINDOW_SEC

export interface EnvironmentSystemMetricsView {
  latest: EnvironmentSystemMetrics | null
  history: SystemMetricsHistoryBucket[]
  error: string | null
}

export function useEnvironmentSystemMetrics(environmentId: string): EnvironmentSystemMetricsView {
  const [latest, setLatest] = useState<EnvironmentSystemMetrics | null>(null)
  const [history, setHistory] = useState<SystemMetricsHistoryBucket[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    rInfo(TAG, 'watching environment system metrics', { environment_id: environmentId })
    const off = onEnvironmentEvent(environmentId, SYSTEM_METRICS_CHANNEL, (payload) => {
      if (!cancelled) setLatest(payload as EnvironmentSystemMetrics)
    })
    ;(action(environmentId, 'environment.systemMetrics.watch', [{ on: true }]) as Promise<{ latest: EnvironmentSystemMetrics | null }>)
      .then((value) => { if (!cancelled && value?.latest) setLatest((cur) => cur ?? value.latest) })
      .catch((err: unknown) => {
        rWarn(TAG, 'system metrics watch failed', { environment_id: environmentId, error: String(err) })
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    ;(action(environmentId, 'environment.systemMetrics.history', [{ windowSec: HISTORY_WINDOW_SEC }]) as Promise<{ buckets: SystemMetricsHistoryBucket[] }>)
      .then((value) => { if (!cancelled) setHistory(value?.buckets ?? []) })
      .catch((err: unknown) => rWarn(TAG, 'system metrics history failed', { environment_id: environmentId, error: String(err) }))
    return () => {
      cancelled = true
      off()
      ;(action(environmentId, 'environment.systemMetrics.watch', [{ on: false }]) as Promise<unknown>)
        .then(() => rInfo(TAG, 'stopped watching environment system metrics', { environment_id: environmentId }))
        .catch((err: unknown) => rWarn(TAG, 'system metrics unwatch failed', { environment_id: environmentId, error: String(err) }))
    }
  }, [environmentId])

  return { latest, history, error }
}

/** Host CPU per live sample, for the sparkline's live tail after the pulled history. */
export function useLiveCpuSeries(latest: EnvironmentSystemMetrics | null): Array<{ at: number; value: number }> {
  const [series, setSeries] = useState<Array<{ at: number; value: number }>>([])
  useEffect(() => {
    const cpu = latest?.host.cpuUtilization
    if (latest == null || cpu == null) return
    setSeries((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].at === latest.sampledAt) return prev
      const next = [...prev, { at: latest.sampledAt, value: cpu }]
      return next.length > LIVE_HISTORY_MAX ? next.slice(next.length - LIVE_HISTORY_MAX) : next
    })
  }, [latest])
  return series
}

export function useDeviceMetrics(): DeviceMetricsSample | null {
  const [sample, setSample] = useState<DeviceMetricsSample | null>(null)
  useEffect(() => {
    // Device Metrics measure this machine's own Electron processes; a
    // browser tab has none, so it shows no "This device" block.
    if (!host.capabilities().includes('nativeShell')) return
    let cancelled = false
    const off = host.shell.onDeviceMetrics((s) => { if (!cancelled) setSample(s) })
    host.shell.deviceMetricsWatch(true)
      .then((s) => { if (!cancelled && s) setSample((cur) => cur ?? s) })
      .catch((err: unknown) => rWarn(TAG, 'device metrics watch failed', { error: String(err) }))
    return () => {
      cancelled = true
      off()
      host.shell.deviceMetricsWatch(false).catch((err: unknown) => rWarn(TAG, 'device metrics unwatch failed', { error: String(err) }))
    }
  }, [])
  return sample
}

export function useTelemetryHealth(environmentId: string): TelemetryHealthState[] {
  const [targets, setTargets] = useState<TelemetryHealthState[]>([])
  useEffect(() => {
    let cancelled = false
    host.getEnvCache(environmentId)
      .then((cache) => {
        const welcome = cache?.welcome
        const replay = welcome && welcome.type === 'studio_welcome' ? welcome.snapshot.telemetryHealth : undefined
        if (!cancelled && replay) setTargets((cur) => (cur.length > 0 ? cur : replay))
      })
      .catch((err: unknown) => rWarn(TAG, 'telemetry health replay read failed', { environment_id: environmentId, error: String(err) }))
    const off = onEnvironmentEvent(environmentId, 'ion:telemetry-health', (payload) => {
      const state = (payload as { state?: TelemetryHealthState } | null)?.state
      if (!state || cancelled) return
      setTargets((prev) => [...prev.filter((t) => t.target !== state.target), state])
    })
    return () => { cancelled = true; off() }
  }, [environmentId])
  return targets
}
