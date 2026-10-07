/**
 * The OTLP metrics export: a gauge is its latest value per attribute set, a
 * histogram accumulates into fixed buckets with cumulative temporality, and
 * the request is the OTLP/JSON shape a collector's /v1/metrics accepts.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { LATENCY_BOUNDS_MS, OtlpMetricsCollector, shipMetricsToOtel } from '../otlp-metrics'
import { resetHostInstallIdForTest } from '../log-egress-resource'

afterEach(() => {
  vi.restoreAllMocks()
  resetHostInstallIdForTest()
})

describe('OtlpMetricsCollector', () => {
  it('builds gauges and histograms into one resource with the collector as the scope', () => {
    let t = 1_000
    const collector = new OtlpMetricsCollector('ion-server', 'server', () => t)
    collector.gauge('ion.server.memory.rss', 100, {}, 'By', 'rss')
    collector.gauge('ion.server.memory.rss', 200, {}, 'By', 'rss') // the latest wins
    collector.observe('ion.server.wire.rtt', 3, { transport: 'relay' })
    collector.observe('ion.server.wire.rtt', 70, { transport: 'relay' })
    collector.observe('ion.server.wire.rtt', 99_999, { transport: 'tcp' })
    t = 2_000
    const built = collector.build({ 'deployment.environment': 'lab' })!
    expect(built.count).toBe(3)
    const rm = built.request.resourceMetrics[0]
    const attrs = Object.fromEntries(rm.resource.attributes.map((a) => [a.key, a.value.stringValue]))
    expect(attrs['service.name']).toBe('ion-server')
    expect(attrs['service.namespace']).toBe('ion')
    expect(attrs['deployment.environment']).toBe('lab')
    expect(rm.scopeMetrics[0].scope.name).toBe('ion-server')
    const [rss, rtt] = rm.scopeMetrics[0].metrics
    expect(rss).toMatchObject({ name: 'ion.server.memory.rss', unit: 'By' })
    expect(rss.gauge?.dataPoints).toEqual([{ attributes: [], timeUnixNano: '1000000000', asDouble: 200 }])
    expect(rtt.histogram?.aggregationTemporality).toBe(2)
    const relay = rtt.histogram!.dataPoints.find((p) => p.attributes[0].value.stringValue === 'relay')!
    expect(relay).toMatchObject({ count: '2', sum: 73, min: 3, max: 70, startTimeUnixNano: '1000000000', timeUnixNano: '2000000000' })
    expect(relay.explicitBounds).toEqual([...LATENCY_BOUNDS_MS])
    expect(relay.bucketCounts).toHaveLength(LATENCY_BOUNDS_MS.length + 1)
    // 3 ms lands in the (2, 5] bucket, 70 ms in (50, 100].
    expect(relay.bucketCounts[2]).toBe('1')
    expect(relay.bucketCounts[6]).toBe('1')
    // An observation above every bound lands in the overflow bucket.
    const tcp = rtt.histogram!.dataPoints.find((p) => p.attributes[0].value.stringValue === 'tcp')!
    expect(tcp.bucketCounts[LATENCY_BOUNDS_MS.length]).toBe('1')
  })

  it('clears gauges after a build, keeps histograms accumulating, and is null when empty', () => {
    const collector = new OtlpMetricsCollector('ion-server', 'server', () => 5)
    expect(collector.build()).toBeNull()
    collector.gauge('g', 1)
    collector.observe('h', 10)
    collector.build()
    collector.observe('h', 20)
    const again = collector.build()!
    expect(again.request.resourceMetrics[0].scopeMetrics[0].metrics.map((m) => m.name)).toEqual(['h'])
    expect(again.request.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram?.dataPoints[0].count).toBe('2')
    expect(collector.hasPoints()).toBe(true)
  })

  it('ignores a value that is not a finite number', () => {
    const collector = new OtlpMetricsCollector('ion-server', 'server')
    collector.gauge('g', Number.NaN)
    collector.observe('h', Number.POSITIVE_INFINITY)
    expect(collector.build()).toBeNull()
  })
})

describe('shipMetricsToOtel', () => {
  it('posts the request to <endpoint>/v1/metrics with the configured headers and reports acceptance', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))
    const request = { resourceMetrics: [] }
    expect(await shipMetricsToOtel(request, 1, { endpoint: 'http://otlp:4318/', headers: { 'x-team': 'ion' } }, { Authorization: 'Bearer t' })).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://otlp:4318/v1/metrics')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ 'Content-Type': 'application/json', 'x-team': 'ion', Authorization: 'Bearer t' })
    expect(JSON.parse(String(init?.body))).toEqual(request)
  })

  it('reports a refused or failed export without throwing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no', { status: 500 }))
    expect(await shipMetricsToOtel({ resourceMetrics: [] }, 1, { endpoint: 'http://otlp:4318' })).toBe(false)
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    expect(await shipMetricsToOtel({ resourceMetrics: [] }, 1, { endpoint: 'http://otlp:4318' })).toBe(false)
  })
})
