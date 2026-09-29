/**
 * `server.json.logging` decides whether a server's own lines leave the host.
 * Before it existed the shipping code was present and never configured, so
 * every server and web line reached a forwarder with no destination.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))

import { defaultLoggingConfig, parseLogging } from '../logging-config'

describe('parseLogging', () => {
  it('ships nothing when the block is absent', () => {
    // The engine's own default, and the reason a default install is unchanged.
    expect(parseLogging(undefined)).toEqual(defaultLoggingConfig())
    expect(parseLogging(undefined).egress).toBeNull()
  })

  it('carries only its own records unless told otherwise', () => {
    // Never claim a file the desktop or engine may already be carrying.
    expect(parseLogging({ egressTargets: ['http'], egressEndpoint: 'https://sink' }).shipSources).toEqual(['server'])
  })

  it('reads a full block', () => {
    const cfg = parseLogging({
      egressTargets: ['http', 'otel'],
      egressEndpoint: 'https://sink/logs',
      egressHeaders: { 'x-team': 'platform', bad: 3 },
      egressBatchSize: 500,
      egressFlushIntervalMs: 2_000,
      egressSpoolMaxBytes: 1024,
      egressOtel: { endpoint: 'https://otlp', serviceName: 'ion-prod' },
      egressShipSources: ['server', 'ios'],
      egressTokenScope: 'api://ion/Telemetry.Write',
    })

    expect(cfg.egress).toMatchObject({
      egressTargets: ['http', 'otel'],
      egressEndpoint: 'https://sink/logs',
      egressBatchSize: 500,
      egressFlushIntervalMs: 2_000,
      egressSpoolMaxBytes: 1024,
    })
    // A non-string header value is dropped rather than shipped as garbage.
    expect(cfg.egress?.egressHeaders).toEqual({ 'x-team': 'platform' })
    expect(cfg.shipSources).toEqual(['server', 'ios'])
    expect(cfg.tokenScope).toBe('api://ion/Telemetry.Write')
  })

  it('ignores a malformed block rather than refusing to boot', () => {
    // Refusing to start a server over a logging preference would be worse than
    // shipping nothing.
    expect(parseLogging('nonsense').egress).toBeNull()
    expect(parseLogging({ egressTargets: 'http' }).egress).toBeNull()
    expect(parseLogging({ egressTargets: [] }).egress).toBeNull()
  })

  it('drops sources it does not recognise and keeps the rest', () => {
    expect(parseLogging({
      egressTargets: ['http'],
      egressShipSources: ['server', 'relay', 42],
    }).shipSources).toEqual(['server'])
  })

  it('honours an explicit empty assignment', () => {
    // "another surface ships on my behalf" is a real answer, not a mistake.
    expect(parseLogging({ egressTargets: ['http'], egressShipSources: [] }).shipSources).toEqual([])
  })
})
