/**
 * engine-egress-claim.test.ts — desktop's claim of engine-log egress.
 *
 * Pins the single-collection-point fix (docs/enterprise/central-log-collection.md):
 * when egress is configured, the desktop stamps logging.egressManagedByClient=true
 * into engine.json so the engine suppresses its own forwarder and the desktop is
 * the sole (authenticated) shipper of engine lines — preventing the double-ship
 * that balloons ~/.ion/.engine-egress-spool.jsonl with 401 failures.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let fakeConfigExists = true
let fakeConfig: Record<string, any> = {}
const written: Array<Record<string, any>> = []

vi.mock('fs', () => ({
  existsSync: vi.fn(() => fakeConfigExists),
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
}))

vi.mock('../settings-store', () => ({
  ENGINE_CONFIG_FILE: '/fake/.ion/engine.json',
  readEngineConfig: vi.fn(() => JSON.parse(JSON.stringify(fakeConfig))),
  writeEngineConfig: vi.fn((cfg: Record<string, any>) => {
    written.push(JSON.parse(JSON.stringify(cfg)))
    fakeConfig = JSON.parse(JSON.stringify(cfg))
  }),
}))

import { claimEngineEgressForDesktop } from '../engine-egress-claim'

beforeEach(() => {
  fakeConfigExists = true
  fakeConfig = {}
  written.length = 0
  vi.clearAllMocks()
})

describe('claimEngineEgressForDesktop', () => {
  it('stamps egressManagedByClient=true when egress targets are configured', () => {
    fakeConfig = { logging: { egressTargets: ['otel'], egressOtel: { endpoint: 'https://x' } } }

    const wrote = claimEngineEgressForDesktop()

    expect(wrote).toBe(true)
    expect(written).toHaveLength(1)
    expect(written[0].logging.egressManagedByClient).toBe(true)
    // Other egress fields must be preserved untouched.
    expect(written[0].logging.egressTargets).toEqual(['otel'])
    expect(written[0].logging.egressOtel).toEqual({ endpoint: 'https://x' })
  })

  it('is idempotent — does not rewrite when already claimed (no config churn)', () => {
    fakeConfig = { logging: { egressTargets: ['otel'], egressManagedByClient: true } }

    const wrote = claimEngineEgressForDesktop()

    expect(wrote).toBe(false)
    expect(written).toHaveLength(0)
  })

  it('no-ops when egress is not configured (headless-equivalent: engine ships for itself)', () => {
    fakeConfig = { logging: { format: 'json' } }

    const wrote = claimEngineEgressForDesktop()

    expect(wrote).toBe(false)
    expect(written).toHaveLength(0)
  })

  it('no-ops when egressTargets is an empty array', () => {
    fakeConfig = { logging: { egressTargets: [] } }

    const wrote = claimEngineEgressForDesktop()

    expect(wrote).toBe(false)
    expect(written).toHaveLength(0)
  })

  it('no-ops when there is no logging block', () => {
    fakeConfig = { backend: 'api' }

    const wrote = claimEngineEgressForDesktop()

    expect(wrote).toBe(false)
    expect(written).toHaveLength(0)
  })

  it('no-ops when engine.json does not exist', () => {
    fakeConfigExists = false

    const wrote = claimEngineEgressForDesktop()

    expect(wrote).toBe(false)
    expect(written).toHaveLength(0)
  })

  it('skips the legacy claim when an explicit shipping matrix is present', () => {
    // The matrix (egressShipSources / egressClientShipSources) governs who
    // ships what; the legacy boolean must not be stamped over it.
    fakeConfig = {
      logging: {
        egressTargets: ['http'],
        egressEndpoint: 'https://x',
        egressShipSources: ['engine'],
      },
    }
    expect(claimEngineEgressForDesktop()).toBe(false)
    expect(written).toHaveLength(0)

    fakeConfig = {
      logging: {
        egressTargets: ['http'],
        egressEndpoint: 'https://x',
        egressClientShipSources: ['desktop', 'engine'],
      },
    }
    expect(claimEngineEgressForDesktop()).toBe(false)
    expect(written).toHaveLength(0)
  })
})
