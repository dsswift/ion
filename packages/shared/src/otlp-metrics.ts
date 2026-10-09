/**
 * otlp-metrics — gauges and histograms shipped as OTLP/JSON metrics
 * (`<endpoint>/v1/metrics`, opentelemetry-proto metrics.proto).
 *
 * The TypeScript twin of the engine's System Metrics exporter: the same
 * request shape, the same resource identity (`log-egress-resource.ts`), so a
 * server's `ion.server.*` series stand beside the engine's `ion.host.*` in
 * one metrics store. Points are batched between flushes the way span records
 * are (`log-egress-traces.ts`): a gauge keeps its latest value per attribute
 * set, a histogram accumulates every observation into fixed buckets, and one
 * export carries what the interval collected. A failed export is logged and
 * the interval's points are dropped: a metric is a sample, and the next
 * interval supplies the next one.
 */
import { warn as _warn, debug as _debug } from './log-sink'
import { otlpAttrValFromAny, type OtlpLogAttr } from './log-egress-otel'
import { egressResourceAttrs } from './log-egress-resource'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('otlp_metrics', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('otlp_metrics', msg, fields)
}

/** Latency bucket bounds in milliseconds: fine under a second, coarse above. */
export const LATENCY_BOUNDS_MS: readonly number[] = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]

/** Cumulative temporality: a counter-like histogram whose buckets grow for the exporter's life. */
const AGGREGATION_TEMPORALITY_CUMULATIVE = 2

export interface OtlpNumberDataPoint {
  attributes: OtlpLogAttr[]
  timeUnixNano: string
  asDouble: number
}

export interface OtlpHistogramDataPoint {
  attributes: OtlpLogAttr[]
  startTimeUnixNano: string
  timeUnixNano: string
  count: string
  sum: number
  min?: number
  max?: number
  bucketCounts: string[]
  explicitBounds: number[]
}

export interface OtlpMetric {
  name: string
  unit?: string
  description?: string
  gauge?: { dataPoints: OtlpNumberDataPoint[] }
  histogram?: { dataPoints: OtlpHistogramDataPoint[]; aggregationTemporality: number }
}

export interface OtlpMetricsExportRequest {
  resourceMetrics: Array<{
    resource: { attributes: OtlpLogAttr[] }
    scopeMetrics: Array<{ scope: { name: string }; metrics: OtlpMetric[] }>
  }>
}

export interface OtlpMetricsConfig {
  endpoint: string
  headers?: Record<string, string>
  resourceAttributes?: Record<string, string>
}

export type MetricAttributes = Record<string, string | number | boolean>

interface GaugeSeries {
  attributes: MetricAttributes
  value: number
  atMs: number
}

interface HistogramSeries {
  attributes: MetricAttributes
  startMs: number
  count: number
  sum: number
  min: number
  max: number
  buckets: number[]
}

interface Instrument {
  name: string
  unit: string
  description: string
  bounds: readonly number[]
  gauges: Map<string, GaugeSeries>
  histograms: Map<string, HistogramSeries>
}

function seriesKey(attributes: MetricAttributes): string {
  return Object.keys(attributes).sort().map((k) => `${k}=${String(attributes[k])}`).join('\n')
}

function toOtlpAttrs(attributes: MetricAttributes): OtlpLogAttr[] {
  return Object.keys(attributes).sort().map((key) => ({ key, value: otlpAttrValFromAny(attributes[key]) }))
}

function nanos(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString()
}

function bucketIndex(bounds: readonly number[], value: number): number {
  let i = 0
  while (i < bounds.length && value > bounds[i]) i++
  return i
}

/**
 * Collects gauges and histograms and builds their OTLP export. Shipping is
 * `shipMetricsToOtel`; a surface's own timer decides the interval.
 */
export class OtlpMetricsCollector {
  private readonly instruments = new Map<string, Instrument>()

  constructor(private readonly scopeName: string, private readonly component: string, private readonly now: () => number = Date.now) {}

  private instrument(name: string, unit: string, description: string, bounds: readonly number[] = LATENCY_BOUNDS_MS): Instrument {
    let inst = this.instruments.get(name)
    if (!inst) {
      inst = { name, unit, description, bounds, gauges: new Map(), histograms: new Map() }
      this.instruments.set(name, inst)
    }
    return inst
  }

  /** The latest value of a gauge for one attribute set. */
  gauge(name: string, value: number, attributes: MetricAttributes = {}, unit = '', description = ''): void {
    if (!Number.isFinite(value)) return
    const inst = this.instrument(name, unit, description)
    inst.gauges.set(seriesKey(attributes), { attributes, value, atMs: this.now() })
  }

  /** One observation into a histogram for one attribute set. */
  observe(name: string, value: number, attributes: MetricAttributes = {}, unit = 'ms', description = '', bounds: readonly number[] = LATENCY_BOUNDS_MS): void {
    if (!Number.isFinite(value)) return
    const inst = this.instrument(name, unit, description, bounds)
    const key = seriesKey(attributes)
    let series = inst.histograms.get(key)
    if (!series) {
      series = { attributes, startMs: this.now(), count: 0, sum: 0, min: value, max: value, buckets: new Array<number>(inst.bounds.length + 1).fill(0) }
      inst.histograms.set(key, series)
    }
    series.count += 1
    series.sum += value
    series.min = Math.min(series.min, value)
    series.max = Math.max(series.max, value)
    series.buckets[bucketIndex(inst.bounds, value)] += 1
  }

  /** Whether anything has been recorded since the last `build`. */
  hasPoints(): boolean {
    for (const inst of this.instruments.values()) {
      if (inst.gauges.size > 0 || inst.histograms.size > 0) return true
    }
    return false
  }

  /**
   * The export of everything collected, or null when nothing was. Gauges are
   * cleared (a stale gauge is not re-sent); histograms keep accumulating,
   * since their temporality is cumulative.
   */
  build(resourceAttributes?: Record<string, string>): { request: OtlpMetricsExportRequest; count: number } | null {
    const metrics: OtlpMetric[] = []
    const at = nanos(this.now())
    let count = 0
    for (const inst of [...this.instruments.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (inst.gauges.size > 0) {
        const dataPoints: OtlpNumberDataPoint[] = []
        for (const series of inst.gauges.values()) {
          dataPoints.push({ attributes: toOtlpAttrs(series.attributes), timeUnixNano: nanos(series.atMs), asDouble: series.value })
        }
        inst.gauges.clear()
        metrics.push({ name: inst.name, unit: inst.unit, description: inst.description, gauge: { dataPoints } })
        count += dataPoints.length
      }
      if (inst.histograms.size > 0) {
        const dataPoints: OtlpHistogramDataPoint[] = []
        for (const series of inst.histograms.values()) {
          dataPoints.push({
            attributes: toOtlpAttrs(series.attributes),
            startTimeUnixNano: nanos(series.startMs),
            timeUnixNano: at,
            count: String(series.count),
            sum: series.sum,
            min: series.min,
            max: series.max,
            bucketCounts: series.buckets.map(String),
            explicitBounds: [...inst.bounds],
          })
        }
        metrics.push({ name: inst.name, unit: inst.unit, description: inst.description, histogram: { dataPoints, aggregationTemporality: AGGREGATION_TEMPORALITY_CUMULATIVE } })
        count += dataPoints.length
      }
    }
    if (count === 0) return null
    const resource = egressResourceAttrs({ ts: '', level: 'INFO', component: this.component, tag: '', msg: '' }, resourceAttributes)
    return { count, request: { resourceMetrics: [{ resource: { attributes: resource }, scopeMetrics: [{ scope: { name: this.scopeName }, metrics }] }] } }
  }
}

/** Posts one export to `<endpoint>/v1/metrics`. Returns whether it was accepted; a failure is logged, never thrown. */
export async function shipMetricsToOtel(request: OtlpMetricsExportRequest, count: number, cfg: OtlpMetricsConfig, authHeaders: Record<string, string> = {}): Promise<boolean> {
  try {
    const res = await fetch(cfg.endpoint.replace(/\/$/, '') + '/v1/metrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cfg.headers ?? {}), ...authHeaders },
      body: JSON.stringify(request),
    })
    if (res.status >= 400) {
      const body = (await res.text().catch(() => '')).slice(0, 512).trim() // silent-ok: the status alone still reports the failure
      throw new Error(body ? `POST returned status ${res.status}: ${body}` : `POST returned status ${res.status}`)
    }
  } catch (err) {
    warn('metrics export failed; this interval\'s points are dropped', { points: count, error: err instanceof Error ? err.message : String(err) })
    return false
  }
  debug('metrics exported', { points: count })
  return true
}
