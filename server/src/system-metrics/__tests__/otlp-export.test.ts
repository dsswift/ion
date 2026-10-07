/**
 * The server's OTLP metrics: each Environment sample becomes the process
 * gauges and a loop-delay observation, each wire window becomes RTT and
 * dwell histograms per transport, and the export is switched by
 * `telemetry.otel.metrics` alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

import { ServerMetricsExporter, SERVER_METRIC_NAMES, installServerMetricsExport } from '../otlp-export'
import { defaultTelemetryConfig, parseTelemetry } from '../../config/telemetry-config'
import type { EnvironmentSystemMetrics } from '@ion/shared/types-system-metrics'

function sample(overrides: Partial<EnvironmentSystemMetrics> = {}): EnvironmentSystemMetrics {
  return {
    sampledAt: 1, intervalMs: 1000,
    host: { cpuUtilization: 0.1, cpuCount: 8, effectiveCpuCount: 8, memoryTotalBytes: 16_000, memoryAvailableBytes: 4_000, memoryLimitBytes: 0, containerLimited: false, load1: 1, diskPath: '/x', diskTotalBytes: 1_000, diskFreeBytes: 250 },
    processes: [{ pid: 2, startTimeMs: 1, role: 'server', name: 'ion-server', cpuPercent: 12.5, cpuTimeMs: 5, rssBytes: 4096 }],
    runtime: { heapBytes: 1, sysBytes: 2, memLimitBytes: 3, goroutines: 4, numGC: 5, sessions: 6 },
    serverEventLoopUtilization: 0.25,
    serverEventLoopDelayP50Ms: 2,
    serverEventLoopDelayP99Ms: 30,
    ...overrides,
  }
}

const config = { enabled: true, endpoint: 'http://otlp.local:4318', intervalMs: 5_000, headers: {}, resourceAttributes: {} }

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('ServerMetricsExporter', () => {
  it('turns a sample into the process gauges, a loop-delay histogram, and the queue depth', () => {
    const exporter = new ServerMetricsExporter(config, () => 777)
    exporter.recordSample(sample())
    const built = exporter.collector.build()!
    const metrics = built.request.resourceMetrics[0].scopeMetrics[0].metrics
    const byName = Object.fromEntries(metrics.map((m) => [m.name, m]))
    expect(byName[SERVER_METRIC_NAMES.cpu].gauge?.dataPoints[0].asDouble).toBeCloseTo(0.125)
    expect(byName[SERVER_METRIC_NAMES.rss].gauge?.dataPoints[0].asDouble).toBe(4096)
    expect(byName[SERVER_METRIC_NAMES.elu].gauge?.dataPoints[0].asDouble).toBe(0.25)
    expect(byName[SERVER_METRIC_NAMES.queueDepth].gauge?.dataPoints[0].asDouble).toBe(777)
    const delay = byName[SERVER_METRIC_NAMES.loopDelay].histogram!
    expect(delay.dataPoints.map((p) => [p.attributes[0].value.stringValue, p.sum])).toEqual([['p50', 2], ['p99', 30]])
    expect(built.request.resourceMetrics[0].resource.attributes.find((a) => a.key === 'service.name')?.value.stringValue).toBe('ion-server')
  })

  it('turns a wire window into RTT and dwell histograms per transport', () => {
    const exporter = new ServerMetricsExporter(config, () => 0)
    exporter.recordWireWindow('relay', [40, 60], [3])
    exporter.recordWireWindow('local', [1], [])
    const metrics = exporter.collector.build()!.request.resourceMetrics[0].scopeMetrics[0].metrics
    const rtt = metrics.find((m) => m.name === SERVER_METRIC_NAMES.rtt)!.histogram!
    expect(rtt.dataPoints.map((p) => [p.attributes[0].value.stringValue, p.count, p.sum])).toEqual([['relay', '2', 100], ['local', '1', 1]])
    const dwell = metrics.find((m) => m.name === SERVER_METRIC_NAMES.dwell)!.histogram!
    expect(dwell.dataPoints).toHaveLength(1)
    expect(dwell.dataPoints[0].bucketCounts.map(Number).reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('ships on flush to /v1/metrics and reports nothing when nothing was collected', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }))
    const exporter = new ServerMetricsExporter(config, () => 0)
    await exporter.flush()
    expect(fetchMock).not.toHaveBeenCalled()
    exporter.recordSample(sample())
    await exporter.flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('http://otlp.local:4318/v1/metrics')
  })

  it('is installed only when the config enables it', () => {
    const source = { onSample: () => () => undefined }
    expect(installServerMetricsExport(defaultTelemetryConfig().otel.metrics, source)).toBeNull()
    const exporter = installServerMetricsExport(config, source)
    expect(exporter).not.toBeNull()
    return exporter!.stop()
  })
})

describe('parseTelemetry', () => {
  it('exports nothing by default, and reads a full block', () => {
    expect(parseTelemetry(undefined)).toEqual(defaultTelemetryConfig())
    expect(parseTelemetry({ otel: { metrics: { enabled: true, endpoint: 'http://otlp:4318/', intervalMs: 15_000, headers: { 'x-a': 'b', bad: 1 }, resourceAttributes: { 'deployment.environment': 'lab' } } } })).toEqual({
      otel: { metrics: { enabled: true, endpoint: 'http://otlp:4318/', intervalMs: 15_000, headers: { 'x-a': 'b' }, resourceAttributes: { 'deployment.environment': 'lab' } } },
    })
  })

  it('refuses to enable without an endpoint and keeps the default interval for a bad one', () => {
    const cfg = parseTelemetry({ otel: { metrics: { enabled: true, intervalMs: 10 } } })
    expect(cfg.otel.metrics.enabled).toBe(false)
    expect(cfg.otel.metrics.intervalMs).toBe(defaultTelemetryConfig().otel.metrics.intervalMs)
    expect(parseTelemetry('nonsense')).toEqual(defaultTelemetryConfig())
  })
})
