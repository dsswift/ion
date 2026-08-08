// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rDebug: vi.fn(),
  listModels: vi.fn(),
}))

vi.mock('../../rendererLogger', () => ({ rDebug: mocks.rDebug }))

import { useModelStore } from '../model-store'

beforeEach(() => {
  vi.clearAllMocks()
  useModelStore.setState({ loading: false, models: [], providers: [] })
  ;(window as unknown as { ion: unknown }).ion = { listModels: mocks.listModels }
})

describe('model store fetch', () => {
  it('logs a failed model fetch and clears its loading state', async () => {
    mocks.listModels.mockRejectedValueOnce(new Error('engine unavailable'))

    await useModelStore.getState().fetchModels()

    expect(useModelStore.getState().loading).toBe(false)
    expect(mocks.rDebug).toHaveBeenCalledWith('model-store', 'fetchModels failed', {
      error: 'Error: engine unavailable',
    })
  })
})
