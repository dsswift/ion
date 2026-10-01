// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rDebug: vi.fn(),
  rWarn: vi.fn(),
  listModels: vi.fn(),
}))

vi.mock('../rendererLogger', () => ({ rDebug: mocks.rDebug, rWarn: mocks.rWarn }))
vi.mock('../host-api', () => ({
  echoUserTurnToStudio: vi.fn(),
  listModels: mocks.listModels,
  on: vi.fn(),
  onProviderLoginEvent: vi.fn(),
  openExternal: vi.fn(),
  providerLoginCancel: vi.fn(),
}))

import { environmentModels, onLocalModelsFetched, useModelStore } from '../model-store'

beforeEach(() => {
  vi.clearAllMocks()
  useModelStore.setState({ loading: false, models: [], providers: [], byEnvironment: {} })
})

describe('model store fetch', () => {
  it('logs a failed model fetch and clears its loading state', async () => {
    mocks.listModels.mockRejectedValueOnce(new Error('engine unavailable'))

    await useModelStore.getState().fetchModels()

    expect(useModelStore.getState().loading).toBe(false)
    expect(mocks.rDebug).toHaveBeenCalledWith('model-store', 'fetchModels failed', {
      environment_id: 'local',
      error: 'Error: engine unavailable',
    })
  })

  // The store itself never saves a preference: in the browser Studio bundle
  // the server's preference writer is a stub that throws.
  it('hands a fresh local catalog to its listeners and nothing else', async () => {
    const models = [{ id: 'claude-sonnet-5', providerId: 'dci-marketing' }]
    mocks.listModels.mockResolvedValue({ models, providers: [] })
    const listener = vi.fn()
    const off = onLocalModelsFetched(listener)
    try {
      await useModelStore.getState().fetchModelsFor('devbox')
      expect(listener).not.toHaveBeenCalled()
      await useModelStore.getState().fetchModels()
      expect(listener).toHaveBeenCalledWith(models)
      expect(mocks.rDebug).not.toHaveBeenCalledWith('model-store', 'normalize model preferences failed', expect.anything())
    } finally {
      off()
    }
  })

  it('logs a listener that throws and still settles the fetch', async () => {
    mocks.listModels.mockResolvedValue({ models: [], providers: [] })
    const off = onLocalModelsFetched(() => { throw new Error('boom') })
    try {
      await useModelStore.getState().fetchModels()
      expect(useModelStore.getState().loading).toBe(false)
      expect(mocks.rWarn).toHaveBeenCalledWith('model-store', 'local models listener failed', { error: 'Error: boom' })
    } finally {
      off()
    }
  })

  it('returns the same local slice until one of its fields changes', () => {
    const first = environmentModels(useModelStore.getState(), 'local')
    expect(environmentModels(useModelStore.getState(), 'local')).toBe(first)
    useModelStore.setState({ loading: true })
    expect(environmentModels(useModelStore.getState(), 'local')).not.toBe(first)
  })
})
