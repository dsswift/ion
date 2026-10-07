/**
 * system-metrics/publisher -- the server end of Environment System Metrics.
 *
 * The server always watches the engine at a slow background interval, so the
 * history ring stays filled and a panel that opens has an hour to show. While
 * a Studio connection watches, the server asks the engine for a sample every
 * second and sends each merged sample to the watching connections on
 * `ion:system-metrics`. A thin connection (the iPhone) that watches gets a
 * small `desktop_system_metrics` summary every ten seconds instead.
 *
 * Nothing here is broadcast to connections that did not ask: a watch is per
 * connection, and it ends when the connection sends `on: false` or goes away.
 */
import type { EnvironmentSystemMetrics, SystemMetricsSample } from '@ion/shared/types-system-metrics'
import { SYSTEM_METRICS_CHANNEL, THIN_EVENT_CHANNEL } from '@ion/shared/studio-wire/channels'
import type { RemoteEvent } from '../remote/protocol'
import { ServerProcessSampler } from './server-process'
import { SystemMetricsStore, mergeEnvironmentMetrics, memoryUsedBytes } from './store'
import { log as _log, warn as _warn, debug as _debug } from '../logger'

const TAG = 'system-metrics'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }
function debug(msg: string, fields?: Record<string, unknown>): void { _debug(TAG, msg, fields) }

/** The engine interval while nobody watches: keeps history filled. */
export const BACKGROUND_ENGINE_INTERVAL_MS = 10_000
/** The engine interval while a Studio connection watches. */
export const LIVE_ENGINE_INTERVAL_MS = 1_000
/** How often a watching thin connection receives its summary. */
export const THIN_SUMMARY_INTERVAL_MS = 10_000
/** How often a sample is logged at INFO, so server.jsonl carries a steady series. */
export const INFO_LOG_INTERVAL_MS = 30_000

/** The engine bridge surface this module uses. */
export interface SystemMetricsEngineLink {
  on(ev: 'event', cb: (key: string, event: { type?: string; systemMetrics?: SystemMetricsSample }) => void): void
  on(ev: 'reconnected', cb: () => void): void
  request<T>(cmd: string, payload?: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: T }>
}

/** The connection surface this module uses. */
export interface SystemMetricsConnection {
  id: string
  view: 'mirror' | 'thin'
  isClosed: boolean
  send(frame: { type: 'studio_event'; channel: string; payload: unknown }): boolean
}

type ThinSummary = Extract<RemoteEvent, { type: 'desktop_system_metrics' }>

interface Watcher {
  conn: SystemMetricsConnection
  lastThinSentAt: number
}

/** Build the phone's summary of one Environment sample. */
export function thinSummary(m: EnvironmentSystemMetrics): ThinSummary {
  const ceiling = m.host.memoryLimitBytes > 0 ? m.host.memoryLimitBytes : m.host.memoryTotalBytes
  return {
    type: 'desktop_system_metrics',
    cpuUtilization: m.host.cpuUtilization,
    memoryUsedFraction: ceiling > 0 ? memoryUsedBytes(m) / ceiling : null,
    diskFreeFraction: m.host.diskTotalBytes > 0 ? m.host.diskFreeBytes / m.host.diskTotalBytes : null,
    sampledAt: m.sampledAt,
  }
}

export class SystemMetricsPublisher {
  readonly store = new SystemMetricsStore()
  private readonly serverSampler = new ServerProcessSampler()
  private readonly watchers = new Map<string, Watcher>()
  private engineIntervalMs = 0
  private lastInfoLogAt = 0
  private readonly sampleListeners = new Set<(sample: EnvironmentSystemMetrics) => void>()

  constructor(private readonly engine: SystemMetricsEngineLink) {}

  /** Subscribe to the engine and start the background watch. */
  install(): void {
    this.engine.on('event', (_key, event) => {
      if (event.type !== 'engine_system_metrics' || !event.systemMetrics) return
      this.ingest(event.systemMetrics)
    })
    // The engine ends a watch when its socket closes, so every reconnect
    // must ask again, and fetch a sample so the store is not stale.
    this.engine.on('reconnected', () => {
      log('engine reconnected; restoring the system metrics watch', { watchers: this.watchers.size })
      this.engineIntervalMs = 0
      void this.syncEngineWatch()
      void this.refresh()
    })
    void this.syncEngineWatch()
    void this.refresh()
  }

  latest(): EnvironmentSystemMetrics | null {
    return this.store.latest()
  }

  /** Hear every merged sample (the OTLP metrics exporter). Returns the unsubscribe. */
  onSample(listener: (sample: EnvironmentSystemMetrics) => void): () => void {
    this.sampleListeners.add(listener)
    return () => { this.sampleListeners.delete(listener) }
  }

  /** Start or stop one connection's watch. Returns the latest sample. */
  watch(conn: SystemMetricsConnection, on: boolean): EnvironmentSystemMetrics | null {
    if (on) {
      this.watchers.set(conn.id, { conn, lastThinSentAt: 0 })
    } else {
      this.watchers.delete(conn.id)
    }
    log('system metrics watch changed', { connection_id: conn.id, view: conn.view, on, watchers: this.watchers.size })
    void this.syncEngineWatch()
    const latest = this.store.latest()
    if (on && latest && conn.view === 'thin') this.sendThin(this.watchers.get(conn.id)!, latest, Date.now())
    return latest
  }

  /** A connection left: end its watch. */
  forget(connectionId: string): void {
    if (!this.watchers.delete(connectionId)) return
    log('system metrics watch ended by disconnect', { connection_id: connectionId, watchers: this.watchers.size })
    void this.syncEngineWatch()
  }

  watcherCount(): number {
    return this.watchers.size
  }

  /** Take in one engine sample: merge, record, and send to watchers. */
  ingest(sample: SystemMetricsSample, now: number = Date.now()): EnvironmentSystemMetrics {
    const merged = mergeEnvironmentMetrics(sample, this.serverSampler.sample(now))
    this.store.record(merged)
    for (const listener of this.sampleListeners) listener(merged)
    let studio = 0
    let thin = 0
    for (const [id, w] of this.watchers) {
      if (w.conn.isClosed) {
        this.forget(id)
        continue
      }
      if (w.conn.view === 'thin') {
        if (now - w.lastThinSentAt >= THIN_SUMMARY_INTERVAL_MS && this.sendThin(w, merged, now)) thin++
      } else if (w.conn.send({ type: 'studio_event', channel: SYSTEM_METRICS_CHANNEL, payload: merged })) {
        studio++
      }
    }
    debug('system metrics sample published', { sampled_at: merged.sampledAt, studio_sent: studio, thin_sent: thin, process_count: merged.processes.length })
    if (now - this.lastInfoLogAt >= INFO_LOG_INTERVAL_MS) {
      this.lastInfoLogAt = now
      log('system metrics sample', serverSampleLogFields(merged, this.watchers.size))
    }
    return merged
  }

  private sendThin(w: Watcher, m: EnvironmentSystemMetrics, now: number): boolean {
    w.lastThinSentAt = now
    return w.conn.send({ type: 'studio_event', channel: THIN_EVENT_CHANNEL, payload: thinSummary(m) })
  }

  /** The engine interval the current watchers need. */
  private wantedEngineInterval(): number {
    for (const w of this.watchers.values()) {
      if (w.conn.view !== 'thin') return LIVE_ENGINE_INTERVAL_MS
    }
    return BACKGROUND_ENGINE_INTERVAL_MS
  }

  private async syncEngineWatch(): Promise<void> {
    const wanted = this.wantedEngineInterval()
    if (wanted === this.engineIntervalMs) return
    this.engineIntervalMs = wanted
    try {
      const res = await this.engine.request<{ intervalMs?: number }>('system_metrics_watch', { intervalMs: wanted })
      if (!res.ok) {
        warn('engine refused the system metrics watch', { interval_ms: wanted, error: res.error ?? '' })
        this.engineIntervalMs = 0
        return
      }
      log('engine system metrics watch set', { requested_interval_ms: wanted, effective_interval_ms: res.data?.intervalMs ?? 0 })
    } catch (err) {
      this.engineIntervalMs = 0
      warn('engine system metrics watch failed', { interval_ms: wanted, error: String(err) })
    }
  }

  private async refresh(): Promise<void> {
    try {
      const res = await this.engine.request<SystemMetricsSample>('get_system_metrics')
      if (res.ok && res.data) {
        this.ingest(res.data)
        return
      }
      warn('get_system_metrics failed', { error: res.error ?? 'no data' })
    } catch (err) {
      warn('get_system_metrics failed', { error: String(err) })
    }
  }
}

/**
 * The server's own figures as flat numeric log fields, so LogQL `unwrap` can
 * chart them from server.jsonl. Host figures are the engine's to log.
 */
export function serverSampleLogFields(m: EnvironmentSystemMetrics, watchers: number): Record<string, unknown> {
  const server = m.processes.find((p) => p.role === 'server')
  return {
    server_cpu_percent: server?.cpuPercent ?? 0,
    server_rss_bytes: server?.rssBytes ?? 0,
    server_event_loop_utilization: m.serverEventLoopUtilization ?? 0,
    server_event_loop_p50_ms: m.serverEventLoopDelayP50Ms ?? 0,
    server_event_loop_p99_ms: m.serverEventLoopDelayP99Ms ?? 0,
    watchers,
  }
}
