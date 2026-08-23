/**
 * Tests for the updateEngineConfig serialized read-mutate-write primitive.
 *
 * Pins: mutation visibility (mutator sees current state and writes are
 * durable), conditional skip (mutator returns false → no write), field
 * preservation (unrelated keys survive), and sequential consistency
 * (back-to-back calls each see the prior call's result).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

let diskConfig: Record<string, any> = {}
const writes: Array<Record<string, any>> = []

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => JSON.stringify(diskConfig)),
  mkdirSync: vi.fn(),
}))

vi.mock('../utils/atomicWrite', () => ({
  atomicWriteFileSync: vi.fn((_path: string, data: string) => {
    const parsed = JSON.parse(data)
    writes.push(parsed)
    diskConfig = parsed
  }),
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('../utils/secretStore', () => ({
  encryptSensitiveSettings: (d: any) => d,
  decryptSensitiveSettings: (d: any) => d,
}))

import {
  updateEngineConfig,
  readEngineConfig,
  ensureHybridBackendConfig,
} from '../settings-store'

beforeEach(() => {
  diskConfig = {}
  writes.length = 0
  vi.clearAllMocks()
})

describe('updateEngineConfig', () => {
  it('reads, mutates, and writes atomically', () => {
    diskConfig = { backend: 'api', defaultModel: 'opus' }

    const wrote = updateEngineConfig((cfg) => {
      cfg.backend = 'hybrid'
    })

    expect(wrote).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0].backend).toBe('hybrid')
    expect(writes[0].defaultModel).toBe('opus')
  })

  it('skips write when mutator returns false', () => {
    diskConfig = { backend: 'hybrid' }

    const wrote = updateEngineConfig((cfg) => {
      if (cfg.backend === 'hybrid') return false
      cfg.backend = 'api'
    })

    expect(wrote).toBe(false)
    expect(writes).toHaveLength(0)
  })

  it('writes when mutator returns undefined (void)', () => {
    diskConfig = {}

    const wrote = updateEngineConfig((cfg) => {
      cfg.newKey = 'value'
    })

    expect(wrote).toBe(true)
    expect(writes[0].newKey).toBe('value')
  })

  it('sequential calls each see prior call result', () => {
    diskConfig = { counter: 0 }

    updateEngineConfig((cfg) => { cfg.counter = 1 })
    updateEngineConfig((cfg) => { cfg.counter = cfg.counter + 1 })

    expect(writes).toHaveLength(2)
    expect(writes[1].counter).toBe(2)
    expect(readEngineConfig().counter).toBe(2)
  })

  it('preserves unrelated fields across mutations', () => {
    diskConfig = { backend: 'api', logging: { format: 'json' }, limits: { max: 10 } }

    updateEngineConfig((cfg) => {
      cfg.backend = 'hybrid'
    })

    expect(writes[0].logging).toEqual({ format: 'json' })
    expect(writes[0].limits).toEqual({ max: 10 })
  })
})

describe('ensureHybridBackendConfig (uses updateEngineConfig)', () => {
  it('sets backend to hybrid when unset', () => {
    diskConfig = {}

    const changed = ensureHybridBackendConfig()

    expect(changed).toBe(true)
    expect(writes[0].backend).toBe('hybrid')
  })

  it('no-ops when already hybrid', () => {
    diskConfig = { backend: 'hybrid' }

    const changed = ensureHybridBackendConfig()

    expect(changed).toBe(false)
    expect(writes).toHaveLength(0)
  })

  it('preserves other config fields', () => {
    diskConfig = { backend: 'api', defaultModel: 'opus', limits: { max: 5 } }

    ensureHybridBackendConfig()

    expect(writes[0].defaultModel).toBe('opus')
    expect(writes[0].limits).toEqual({ max: 5 })
  })
})
