// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ rDebug: vi.fn() }))
vi.mock('../../rendererLogger', () => ({ rDebug: mocks.rDebug }))

import { useModelStore } from '../model-store'
import type { ModelEntry, ProviderEntry } from '../../../shared/types-models'

// Whether a conversation is served by a delegated CLI decides what the engine
// can honestly promise about compaction. The signal is the provider entry's
// effective backend, which the engine derives from the same routing helper a
// run uses — so what the UI states is what the next run will actually do.

const model = (id: string, providerId: string) => ({ id, providerId } as ModelEntry)
const provider = (id: string, backend?: string) => ({ id, hasAuth: true, backend } as ProviderEntry)

beforeEach(() => {
  vi.clearAllMocks()
  useModelStore.setState({
    loading: false,
    models: [
      model('claude-opus-5', 'anthropic'),
      model('gpt-5', 'openai'),
      model('local-thing', 'ollama'),
    ],
    providers: [
      provider('anthropic', 'claude-code'),
      provider('openai', 'api'),
      provider('ollama'),
    ],
  })
})

describe('isModelCliServed', () => {
  it('is true when the model routes to a delegated CLI', () => {
    expect(useModelStore.getState().isModelCliServed('claude-opus-5')).toBe(true)
  })

  it('is false when the model routes to the engine', () => {
    expect(useModelStore.getState().isModelCliServed('gpt-5')).toBe(false)
  })

  it('is false when the provider reports no backend', () => {
    expect(useModelStore.getState().isModelCliServed('local-thing')).toBe(false)
  })

  it('is false for an empty or unknown model id', () => {
    expect(useModelStore.getState().isModelCliServed('')).toBe(false)
    expect(useModelStore.getState().isModelCliServed('nope')).toBe(false)
  })

  it('follows a routing change without a reload', () => {
    // The operator adds an API key: the same model now routes to the engine.
    useModelStore.setState({ providers: [provider('anthropic', 'api')] })
    expect(useModelStore.getState().isModelCliServed('claude-opus-5')).toBe(false)
  })
})
