/**
 * Round-trip tests for the plan-mode Bash allowlist store.
 *
 * The store is the single main-process seam that reads/writes the allowlist
 * in engine.json (limits.planModeAllowedBashCommands). These tests pin that
 * it reads what it writes, preserves other engine.json fields, treats absent
 * / malformed values as empty (opinionless default), and persists an explicit
 * empty array (the "block Bash" signal) rather than dropping the key.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// engine.json contents live in this hoisted fake; the settings-store mock
// reads/writes it so the test never touches the real ~/.ion/engine.json.
const store = vi.hoisted(() => ({ engineConfig: {} as Record<string, unknown> }))

vi.mock('../settings-store', () => ({
  readEngineConfig: () => JSON.parse(JSON.stringify(store.engineConfig)),
  writeEngineConfig: (cfg: Record<string, unknown>) => { store.engineConfig = cfg },
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

import { readPlanBashAllowlist, writePlanBashAllowlist } from '../plan-bash-allowlist-store'

describe('plan-bash-allowlist-store', () => {
  beforeEach(() => {
    store.engineConfig = {}
  })

  it('reads back exactly what it writes', () => {
    writePlanBashAllowlist(['gh', 'git log', 'git diff'])
    expect(readPlanBashAllowlist()).toEqual(['gh', 'git log', 'git diff'])
  })

  it('returns [] when engine.json is empty (opinionless default = Bash blocked)', () => {
    expect(readPlanBashAllowlist()).toEqual([])
  })

  it('returns [] when limits exists but the key is absent', () => {
    store.engineConfig = { limits: { maxTurns: 100 } }
    expect(readPlanBashAllowlist()).toEqual([])
  })

  it('treats a non-array value as empty', () => {
    store.engineConfig = { limits: { planModeAllowedBashCommands: 'gh' } }
    expect(readPlanBashAllowlist()).toEqual([])
  })

  it('persists an explicit empty array (block-Bash signal), not a deleted key', () => {
    writePlanBashAllowlist([])
    const limits = store.engineConfig.limits as Record<string, unknown>
    expect(limits.planModeAllowedBashCommands).toEqual([])
    expect(readPlanBashAllowlist()).toEqual([])
  })

  it('preserves other engine.json fields on write', () => {
    store.engineConfig = { backend: 'hybrid', limits: { maxTurns: 42 }, defaultModel: 'claude-opus-4-6' }
    writePlanBashAllowlist(['gh'])
    expect(store.engineConfig.backend).toBe('hybrid')
    expect(store.engineConfig.defaultModel).toBe('claude-opus-4-6')
    const limits = store.engineConfig.limits as Record<string, unknown>
    expect(limits.maxTurns).toBe(42)
    expect(limits.planModeAllowedBashCommands).toEqual(['gh'])
  })

  it('filters non-string elements defensively on read', () => {
    store.engineConfig = { limits: { planModeAllowedBashCommands: ['gh', 42, 'git log', null] } }
    expect(readPlanBashAllowlist()).toEqual(['gh', 'git log'])
  })
})
