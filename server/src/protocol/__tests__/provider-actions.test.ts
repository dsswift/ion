/**
 * Pins the `provider.*` / `model.*` studio_action surface.
 *
 * Context: these operations lived inside `desktop/src/main/ipc/models.ts`
 * and `providers.ts`, reachable only over Electron IPC, so a browser Studio
 * client could not list models, store a credential, or set a default
 * provider — its whole AI & Models settings category was hidden for want of
 * a transport rather than an implementation.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const bridge = vi.hoisted(() => ({
  listModels: vi.fn(async () => ({ models: [], providers: [] })),
  listModelTiers: vi.fn(async () => [{ name: 'fast' }]),
  storeCredential: vi.fn(async () => ({ ok: true })),
  setModelTier: vi.fn(async () => ({ ok: true })),
  providerLogin: vi.fn(async () => ({ ok: true })),
  on: vi.fn(),
}))
vi.mock('../../state', () => ({ engineBridge: bridge, deviceFocusMap: new Map(), state: { remoteTransport: null } }))
vi.mock('../../engine/ipc/models', () => ({
  updateCache: vi.fn(),
  refreshModelCache: vi.fn(async () => {}),
  setModelCacheUpdateNotifier: vi.fn(),
}))

import { PROVIDER_ACTIONS } from '../provider-actions'
import { HOST_ONLY_LOGIN_REFUSAL } from '@ion/shared/types-models'
import type { Connection } from '../connection'

const conn = { id: 'conn-test', scopes: [] } as unknown as Connection

beforeEach(() => {
  bridge.storeCredential.mockClear().mockResolvedValue({ ok: true })
  bridge.setModelTier.mockClear().mockResolvedValue({ ok: true })
})

describe('PROVIDER_ACTIONS scopes', () => {
  it('reads need only conversations:read so a non-admin can render a model picker', () => {
    expect(PROVIDER_ACTIONS['model.list'].requiredScope).toBe('conversations:read')
    expect(PROVIDER_ACTIONS['model.listTiers'].requiredScope).toBe('conversations:read')
    expect(PROVIDER_ACTIONS['provider.getDefault'].requiredScope).toBe('conversations:read')
    expect(PROVIDER_ACTIONS['provider.subscription'].requiredScope).toBe('conversations:read')
  })

  it('writes require admin, because they reconfigure a SHARED engine', () => {
    for (const name of [
      'model.setTier', 'model.removeTier', 'model.refresh',
      'provider.setDefault', 'provider.storeCredential',
      'provider.login', 'provider.loginCancel', 'provider.loginCode', 'provider.logout',
      'provider.selectSubscription', 'provider.refreshSubscription',
    ]) {
      expect(PROVIDER_ACTIONS[name].requiredScope, name).toBe('admin')
    }
  })
})

describe('PROVIDER_ACTIONS dispatch', () => {
  it('stores a credential with the same payload shape the preload sends', async () => {
    const outcome = await PROVIDER_ACTIONS['provider.storeCredential'].handler(conn, [
      { provider: 'anthropic', credential: 'sk-test' },
    ])
    expect(outcome.ok).toBe(true)
    expect(bridge.storeCredential).toHaveBeenCalledWith('anthropic', 'sk-test')
  })

  it('refuses a malformed credential payload instead of forwarding it', async () => {
    const outcome = await PROVIDER_ACTIONS['provider.storeCredential'].handler(conn, [{ provider: 'anthropic' }])
    expect(outcome).toEqual({ ok: true, value: { ok: false, error: 'a provider and a credential string are required' } })
    expect(bridge.storeCredential).not.toHaveBeenCalled()
  })

  it('forwards an empty credential, which is how a client removes a stored key', async () => {
    const outcome = await PROVIDER_ACTIONS['provider.storeCredential'].handler(conn, [
      { provider: 'openai', credential: '' },
    ])
    expect(outcome).toEqual({ ok: true, value: { ok: true } })
    expect(bridge.storeCredential).toHaveBeenCalledWith('openai', '')
  })

  it('turns a thrown engine error into a typed action error rather than dropping the reply', async () => {
    bridge.setModelTier.mockRejectedValueOnce(new Error('engine down'))
    const outcome = await PROVIDER_ACTIONS['model.setTier'].handler(conn, [
      { name: 'fast', model: 'claude-sonnet-5', fallbacks: [] },
    ])
    expect(outcome.ok).toBe(false)
    expect(outcome).toMatchObject({ error: { code: 'provider_action_failed' } })
  })

  it('answers model.list from the engine bridge', async () => {
    const outcome = await PROVIDER_ACTIONS['model.list'].handler(conn, [])
    expect(outcome.ok).toBe(true)
    expect(bridge.listModels).toHaveBeenCalled()
  })
})

describe('provider.login placement', () => {
  const providers = [
    { id: 'xai', loginFlow: 'browser-callback' },
    { id: 'anthropic', loginFlow: 'browser-code' },
    { id: 'openai', loginFlow: 'browser-or-device-code' },
  ]
  const onHost = { id: 'c-local', transport: 'local', scopes: ['admin'] } as unknown as Connection
  const offHost = { id: 'c-tcp', transport: 'tcp', scopes: ['admin'] } as unknown as Connection

  beforeEach(() => {
    bridge.providerLogin.mockClear()
    bridge.listModels.mockResolvedValue({ models: [], providers } as never)
  })

  it('refuses a host-only browser-callback sign-in from a connection that is not on the host', async () => {
    const outcome = await PROVIDER_ACTIONS['provider.login'].handler(offHost, [{ provider: 'xai' }])
    expect(outcome).toEqual({ ok: true, value: { ok: false, error: HOST_ONLY_LOGIN_REFUSAL } })
    expect(bridge.providerLogin).not.toHaveBeenCalled()
  })

  it('starts paste-code and device-code sign-ins off the host, and every sign-in on the host', async () => {
    await PROVIDER_ACTIONS['provider.login'].handler(offHost, [{ provider: 'anthropic' }])
    await PROVIDER_ACTIONS['provider.login'].handler(offHost, [{ provider: 'openai' }])
    await PROVIDER_ACTIONS['provider.login'].handler(onHost, [{ provider: 'xai' }])
    expect(bridge.providerLogin.mock.calls).toEqual([['anthropic'], ['openai'], ['xai']])
  })
})
