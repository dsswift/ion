/**
 * `server.json.telemetry` -- what this server exports about itself beyond its
 * log lines. One block today: `telemetry.otel.metrics`, the OTLP metrics
 * exporter for the server process (`system-metrics/otlp-export.ts`): CPU,
 * memory, event loop, the wire's round trips and queue waits, the broadcast
 * queue. Absent means export nothing, the same default as the engine's
 * `telemetry.otel.metrics`.
 */
import { warn as _warn } from '../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('server-config', msg, fields)
}

export const DEFAULT_METRICS_INTERVAL_MS = 60_000
export const MIN_METRICS_INTERVAL_MS = 5_000

export interface ServerOtelMetricsConfig {
  enabled: boolean
  /** The OTLP/HTTP base; `/v1/metrics` is appended. Required when enabled. */
  endpoint: string
  intervalMs: number
  headers: Record<string, string>
  /** Added to the exported resource, the way the egress config's are. */
  resourceAttributes: Record<string, string>
}

export interface ServerTelemetryConfig {
  otel: { metrics: ServerOtelMetricsConfig }
}

export function defaultTelemetryConfig(): ServerTelemetryConfig {
  return { otel: { metrics: { enabled: false, endpoint: '', intervalMs: DEFAULT_METRICS_INTERVAL_MS, headers: {}, resourceAttributes: {} } } }
}

function asStringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/**
 * Parse the block. Anything malformed is reported and replaced by the
 * default: refusing to boot over a metrics preference would be worse than
 * exporting nothing.
 */
export function parseTelemetry(raw: unknown): ServerTelemetryConfig {
  const defaults = defaultTelemetryConfig()
  if (raw === undefined || raw === null) return defaults
  if (typeof raw !== 'object') {
    warn('server.json.telemetry ignored: expected an object', { type: typeof raw })
    return defaults
  }
  const otel = (raw as Record<string, unknown>).otel
  const metrics = otel && typeof otel === 'object' ? (otel as Record<string, unknown>).metrics : undefined
  if (metrics === undefined) return defaults
  if (!metrics || typeof metrics !== 'object') {
    warn('server.json.telemetry.otel.metrics ignored: expected an object', { type: typeof metrics })
    return defaults
  }
  const m = metrics as Record<string, unknown>
  const enabled = m.enabled === true
  const endpoint = typeof m.endpoint === 'string' ? m.endpoint.trim() : ''
  if (enabled && !endpoint) {
    warn('server.json.telemetry.otel.metrics is enabled with no endpoint; nothing is exported')
  }
  let intervalMs = DEFAULT_METRICS_INTERVAL_MS
  if (m.intervalMs !== undefined) {
    if (typeof m.intervalMs === 'number' && Number.isFinite(m.intervalMs) && m.intervalMs >= MIN_METRICS_INTERVAL_MS) {
      intervalMs = Math.round(m.intervalMs)
    } else {
      warn('server.json.telemetry.otel.metrics.intervalMs ignored: below the minimum or not a number', { value: m.intervalMs, min_ms: MIN_METRICS_INTERVAL_MS })
    }
  }
  return {
    otel: {
      metrics: {
        enabled: enabled && endpoint !== '',
        endpoint,
        intervalMs,
        headers: asStringRecord(m.headers),
        resourceAttributes: asStringRecord(m.resourceAttributes),
      },
    },
  }
}
