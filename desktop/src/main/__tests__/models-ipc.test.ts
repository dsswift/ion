import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, bridge } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  bridge: {
    listModels: vi.fn(),
    listModelTiers: vi.fn(),
    setModelTier: vi.fn(),
    removeModelTier: vi.fn(),
    on: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) },
}))
vi.mock('../state', () => ({ engineBridge: bridge, modelCache: {}, enterprisePolicyCache: {} }))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn() }))

import { IPC } from '../../shared/types'
import { modelCache } from '../state'
import { refreshModelCache, registerModelsIpc } from '../ipc/models'

registerModelsIpc()

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`missing handler ${channel}`)
  return handler({}, payload) as Promise<T>
}

beforeEach(() => vi.clearAllMocks())

describe('model tier IPC', () => {
  it('rejects malformed mutation payloads without calling bridge', async () => {
    await expect(invoke(IPC.SET_MODEL_TIER, null)).resolves.toEqual({ ok: false, error: 'set_model_tier requires name, model, and string fallbacks' })
    await expect(invoke(IPC.SET_MODEL_TIER, { name: 'standard', model: 'model', fallbacks: [42] })).resolves.toEqual({ ok: false, error: 'set_model_tier requires name, model, and string fallbacks' })
    await expect(invoke(IPC.REMOVE_MODEL_TIER, { name: 42 })).resolves.toEqual({ ok: false, error: 'remove_model_tier requires a tier name' })

    expect(bridge.setModelTier).not.toHaveBeenCalled()
    expect(bridge.removeModelTier).not.toHaveBeenCalled()
  })

  it('forwards list, set, and remove commands through engine bridge', async () => {
    const tier = { name: 'standard', model: 'provider/model', fallbacks: ['provider/backup'] }
    bridge.listModelTiers.mockResolvedValue([tier])
    bridge.setModelTier.mockResolvedValue({ ok: true })
    bridge.removeModelTier.mockResolvedValue({ ok: true })

    await expect(invoke(IPC.LIST_MODEL_TIERS)).resolves.toEqual([tier])
    await expect(invoke(IPC.SET_MODEL_TIER, tier)).resolves.toEqual({ ok: true })
    await expect(invoke(IPC.REMOVE_MODEL_TIER, { name: tier.name })).resolves.toEqual({ ok: true })

    expect(bridge.listModelTiers).toHaveBeenCalledOnce()
    expect(bridge.setModelTier).toHaveBeenCalledWith(tier)
    expect(bridge.removeModelTier).toHaveBeenCalledWith(tier.name)
  })
})

// The cache IS the iOS projection: snapshot-polling and transport-init send
// modelCache.models straight through as availableModels. A capability the
// engine publishes but the cache drops never reaches the phone, so iOS falls
// back to a generic reserve and reports a different remaining input budget
// than the desktop does for the same conversation.
describe('model cache projection', () => {
  it('carries the capacity capabilities iOS needs to size input budget', async () => {
    bridge.listModels.mockResolvedValue({
      providers: [{ id: 'anthropic', hasAuth: true }],
      models: [{
        id: 'anthropic/claude',
        providerId: 'anthropic',
        contextWindow: 200_000,
        maxOutputTokens: 32_000,
        effectiveContextLimit: 155_000,
      }],
    })

    await refreshModelCache()

    expect(modelCache.models[0]).toMatchObject({
      id: 'anthropic/claude',
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      effectiveContextLimit: 155_000,
    })
  })
})
