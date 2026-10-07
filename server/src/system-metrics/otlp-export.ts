/**
 * The server's own OTLP metrics (`server.json` `telemetry.otel.metrics`):
 * the runtime figures of this process, the wire as its connections feel it,
 * and the broadcast queue, exported on an interval as gauges and histograms
 * (`@ion/shared/otlp-metrics`). Latency distributions of operations are not
 * here by design: those come from span metrics (log-schema § Spans); this
 * covers what no span measures.
 *
 * | Metric | Kind | Source |
 * |---|---|---|
 * | `ion.server.cpu.utilization` | gauge, 0..1 | the server process sample |
 * | `ion.server.memory.rss` | gauge, bytes | the server process sample |
 * | `ion.server.event_loop.utilization` | gauge, 0..1 | the server process sample |
 * | `ion.server.event_loop.delay` | histogram, ms | the loop-delay histogram's p50, p99, max per sample |
 * | `ion.server.wire.rtt` | histogram, ms, `transport` | every round trip of every wire window |
 * | `ion.server.wire.dwell` | histogram, ms, `transport` | every queue wait of every wire window |
 * | `ion.server.broadcast.queue_depth` | gauge, bytes | the largest send buffer across live connections, per sample |
 */
import { OtlpMetricsCollector, shipMetricsToOtel } from '@ion/shared/otlp-metrics'
import type { EnvironmentSystemMetrics } from '@ion/shared/types-system-metrics'
import type { ServerOtelMetricsConfig } from '../config/telemetry-config'
import { onWireWindow } from '../protocol/wire-latency'
import { connectionRegistry } from '../protocol/connection'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'otlp-metrics'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export const SERVER_METRIC_NAMES = {
  cpu: 'ion.server.cpu.utilization',
  rss: 'ion.server.memory.rss',
  elu: 'ion.server.event_loop.utilization',
  loopDelay: 'ion.server.event_loop.delay',
  rtt: 'ion.server.wire.rtt',
  dwell: 'ion.server.wire.dwell',
  queueDepth: 'ion.server.broadcast.queue_depth',
} as const

/** What the exporter reads from the publisher: one callback per merged sample. */
export interface SampleSource {
  onSample(listener: (sample: EnvironmentSystemMetrics) => void): () => void
}

export class ServerMetricsExporter {
  readonly collector = new OtlpMetricsCollector('ion-server', 'server')
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly unsubscribe: Array<() => void> = []

  constructor(
    private readonly config: ServerOtelMetricsConfig,
    private readonly queueDepth: () => number = largestSendBuffer,
  ) {}

  /** Records one Environment sample's server figures. */
  recordSample(sample: EnvironmentSystemMetrics): void {
    const server = sample.processes.find((p) => p.role === 'server')
    if (server?.cpuPercent !== null && server?.cpuPercent !== undefined) this.collector.gauge(SERVER_METRIC_NAMES.cpu, server.cpuPercent / 100, {}, '1', 'CPU time of the server process per wall-clock second')
    if (server) this.collector.gauge(SERVER_METRIC_NAMES.rss, server.rssBytes, {}, 'By', 'Resident set size of the server process')
    if (sample.serverEventLoopUtilization !== null) this.collector.gauge(SERVER_METRIC_NAMES.elu, sample.serverEventLoopUtilization, {}, '1', 'Share of the event loop spent busy')
    if (typeof sample.serverEventLoopDelayP50Ms === 'number' && typeof sample.serverEventLoopDelayP99Ms === 'number') {
      this.collector.observe(SERVER_METRIC_NAMES.loopDelay, sample.serverEventLoopDelayP50Ms, { quantile: 'p50' }, 'ms', 'How late the event loop ran its timers')
      this.collector.observe(SERVER_METRIC_NAMES.loopDelay, sample.serverEventLoopDelayP99Ms, { quantile: 'p99' }, 'ms', 'How late the event loop ran its timers')
    }
    this.collector.gauge(SERVER_METRIC_NAMES.queueDepth, this.queueDepth(), {}, 'By', 'The largest send buffer across live connections')
  }

  /** Records one wire window's raw samples under its transport. */
  recordWireWindow(transport: string, rtts: readonly number[], dwells: readonly number[]): void {
    for (const rtt of rtts) this.collector.observe(SERVER_METRIC_NAMES.rtt, rtt, { transport }, 'ms', 'Studio wire round trip, studio_ping to studio_pong')
    for (const dwell of dwells) this.collector.observe(SERVER_METRIC_NAMES.dwell, dwell, { transport }, 'ms', 'Time a frame waited in the send queue')
  }

  /** Subscribes to the sources and starts the interval. Idempotent. */
  start(samples: SampleSource): void {
    if (this.timer) return
    this.unsubscribe.push(samples.onSample((sample) => this.recordSample(sample)))
    this.unsubscribe.push(onWireWindow((identity, _window, raw) => this.recordWireWindow(identity.transport, raw.rtts, raw.dwells)))
    this.timer = setInterval(() => { void this.flush() }, this.config.intervalMs)
    this.timer.unref?.()
    log('server metrics export started', { endpoint: this.config.endpoint, interval_ms: this.config.intervalMs })
  }

  /** Ships what the interval collected. */
  async flush(): Promise<void> {
    const built = this.collector.build(this.config.resourceAttributes)
    if (!built) return
    const accepted = await shipMetricsToOtel(built.request, built.count, { endpoint: this.config.endpoint, headers: this.config.headers })
    if (!accepted) warn('server metrics interval not accepted by the endpoint', { points: built.count, endpoint: this.config.endpoint })
  }

  /** Stops the interval after one final flush. */
  async stop(): Promise<void> {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    for (const off of this.unsubscribe.splice(0)) off()
    await this.flush()
    log('server metrics export stopped')
  }
}

/** The deepest send queue among live connections, in bytes: the broadcast backlog a slow client holds. */
function largestSendBuffer(): number {
  let max = 0
  for (const conn of connectionRegistry.all()) {
    if (!conn.isClosed && conn.buffer.size > max) max = conn.buffer.size
  }
  return max
}

let active: ServerMetricsExporter | null = null

/** Starts the exporter when the config enables it. Returns it, or null when export is off. */
export function installServerMetricsExport(config: ServerOtelMetricsConfig, samples: SampleSource): ServerMetricsExporter | null {
  if (!config.enabled) {
    log('server metrics export off: telemetry.otel.metrics is not enabled')
    return null
  }
  active = new ServerMetricsExporter(config)
  active.start(samples)
  return active
}

export function serverMetricsExporter(): ServerMetricsExporter | null {
  return active
}
