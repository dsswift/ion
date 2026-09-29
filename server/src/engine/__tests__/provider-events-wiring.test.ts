/**
 * The engine's tier and default-provider snapshots reach clients with the
 * snapshot as the payload, so a client can apply it rather than re-read: the
 * engine answers every tier read with the same event, and a client that
 * re-read on each one would never stop.
 */
import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ emitter: null as unknown as EventEmitter }))
vi.mock('../../state', async () => {
  const { EventEmitter: Emitter } = await import('events')
  bridge.emitter = new Emitter()
  return { engineBridge: bridge.emitter }
})
vi.mock('../ipc/models', () => ({ updateCache: vi.fn(), refreshModelCache: vi.fn(async () => {}) }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { wireProviderEvents } from '../provider-api'

describe('wireProviderEvents', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    bridge.emitter.removeAllListeners()
    vi.useRealTimers()
  })

  it('sends the tier snapshot with the tiers signal', () => {
    const emit = vi.fn()
    wireProviderEvents(emit)
    const tiers = [{ name: 'fast', model: 'claude-haiku', fallbacks: [] }]
    bridge.emitter.emit('event', 'key', { type: 'engine_model_tiers', modelTiers: tiers })
    expect(emit).toHaveBeenCalledWith('ion:model-tiers-updated', { modelTiers: tiers })
  })

  it('sends the default provider with the default-provider signal, empty when cleared', () => {
    const emit = vi.fn()
    wireProviderEvents(emit)
    bridge.emitter.emit('event', 'key', { type: 'engine_default_provider', defaultProvider: 'anthropic' })
    bridge.emitter.emit('event', 'key', { type: 'engine_default_provider' })
    expect(emit.mock.calls).toEqual([
      ['ion:default-provider-updated', { defaultProvider: 'anthropic' }],
      ['ion:default-provider-updated', { defaultProvider: '' }],
    ])
  })
})
