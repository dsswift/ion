import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(),
}))

// vi.mock factories are hoisted above module scope, so the shared refs they
// close over must be created with vi.hoisted.
const { settings, state } = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  state: { rendererSnapshotCache: null } as {
    rendererSnapshotCache: { tabs: Array<Record<string, unknown>> } | null
  },
}))

vi.mock('../settings-store', () => ({ readSettings: () => settings }))
vi.mock('../state', () => ({ state }))

import { resolveEngineModel } from '../resolve-engine-model'

beforeEach(() => {
  for (const k of Object.keys(settings)) delete settings[k]
  state.rendererSnapshotCache = null
})

describe('resolveEngineModel', () => {
  // The precedence chain must match the renderer's __Ion_resolveEngineModel
  // exactly. Two divergent chains would surface as the phone and the desktop
  // disagreeing about which model a tab is on — a difference nobody would
  // think to look for.
  it('prefers the tab override above every preference', () => {
    state.rendererSnapshotCache = { tabs: [{ id: 'tab-1', modelOverride: 'claude-opus-5' }] }
    settings.engineDefaultModel = 'default-model'
    settings.preferredModel = 'preferred-model'

    expect(resolveEngineModel('tab-1')).toBe('claude-opus-5')
  })

  it('falls back to engineDefaultModel when no override is set', () => {
    state.rendererSnapshotCache = { tabs: [{ id: 'tab-1', modelOverride: null }] }
    settings.engineDefaultModel = 'default-model'
    settings.preferredModel = 'preferred-model'

    expect(resolveEngineModel('tab-1')).toBe('default-model')
  })

  it('falls back to preferredModel when engineDefaultModel is unset', () => {
    settings.preferredModel = 'preferred-model'
    expect(resolveEngineModel('tab-1')).toBe('preferred-model')
  })

  it('falls back to the compiled default when nothing is configured', () => {
    expect(resolveEngineModel('tab-1')).toBe('claude-sonnet-4-6')
  })

  // A resync must still answer for a tab main has never projected; returning
  // '' would send an empty model override to the phone.
  it('resolves for an unknown tab rather than returning empty', () => {
    state.rendererSnapshotCache = { tabs: [{ id: 'other', modelOverride: 'x' }] }
    settings.preferredModel = 'preferred-model'

    expect(resolveEngineModel('never-seen')).toBe('preferred-model')
  })

  it('tolerates a missing snapshot cache entirely', () => {
    state.rendererSnapshotCache = null
    settings.engineDefaultModel = 'default-model'

    expect(resolveEngineModel('tab-1')).toBe('default-model')
  })
})
