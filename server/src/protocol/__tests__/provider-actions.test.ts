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
  connect: vi.fn(async () => {}),
  _sendWithResult: vi.fn(async () => ({ ok: true })),
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
      'provider.remove', 'provider.selectSubscription', 'provider.refreshSubscription',
    ]) {
      expect(PROVIDER_ACTIONS[name].requiredScope, name).toBe('admin')
    }
  })
})

describe('PROVIDER_ACTIONS dispatch', () => {
  it('removes a provider through the engine provider_remove command', async () => {
    bridge._sendWithResult.mockClear()
    const outcome = await PROVIDER_ACTIONS['provider.remove'].handler(conn, [{ provider: 'corp-gateway' }])
    expect(outcome).toEqual({ ok: true, value: { ok: true } })
    expect(bridge._sendWithResult).toHaveBeenCalledWith({ cmd: 'provider_remove', provider: 'corp-gateway' })
  })

  it('refuses a removal with no provider instead of forwarding it', async () => {
    bridge._sendWithResult.mockClear()
    const outcome = await PROVIDER_ACTIONS['provider.remove'].handler(conn, [{}])
    expect(outcome).toEqual({ ok: true, value: { ok: false, error: 'provider is required' } })
    expect(bridge._sendWithResult).not.toHaveBeenCalled()
  })

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

describe('PROVIDER_ACTIONS on a managed engine configuration', () => {
  it('refuses a plan-mode Bash allowlist write with the managed-config code', async () => {
    const { setManagedEngineConfigSource } = await import('../../persistence/settings-store')
    const { MANAGED_CONFIG_WRITE_REFUSED } = await import('@ion/shared/types-enterprise')
    setManagedEngineConfigSource({ path: null })
    try {
      const outcome = await PROVIDER_ACTIONS['planBashAllowlist.set'].handler(conn, [['gh']])
      expect(outcome).toMatchObject({ ok: false, error: { code: MANAGED_CONFIG_WRITE_REFUSED } })
    } finally {
      setManagedEngineConfigSource(null)
    }
  })

  it('passes the engine refusal code of a tier write back to the caller', async () => {
    bridge.setModelTier.mockResolvedValue({ ok: false, error: 'models configuration is owned by the managed source', code: 'managed_config_write_refused' } as never)
    const outcome = await PROVIDER_ACTIONS['model.setTier'].handler(conn, [{ name: 'fast', model: 'm', fallbacks: [] }])
    expect(outcome).toMatchObject({ ok: true, value: { ok: false, code: 'managed_config_write_refused' } })
  })
})

const person = vi.hoisted(() => ({
  enabled: true,
  subscription: vi.fn(async (subject: string) => ({ ok: true, subscription: { state: 'applied', who: subject } })),
  select: vi.fn(async (subject: string, payload: unknown) => ({ ok: true, subscription: { state: 'applied', who: subject, payload } })),
  refresh: vi.fn(async (subject: string) => ({ ok: true, subscription: { state: 'resolving', who: subject } })),
}))
vi.mock('../../subscription/person-api', () => ({
  personLookupEnabled: () => person.enabled,
  personSubscription: person.subscription,
  selectPersonSubscription: person.select,
  refreshPersonSubscription: person.refresh,
}))
vi.mock('../../engine/provider-subscription-api', () => ({
  getProviderSubscription: vi.fn(async () => ({ ok: true, subscription: { state: 'engine' } })),
  selectProviderSubscription: vi.fn(async () => ({ ok: true, subscription: { state: 'engine-selected' } })),
  refreshProviderSubscription: vi.fn(async () => ({ ok: true, subscription: { state: 'engine-refreshed' } })),
}))

describe('the per-person Provider Subscription actions', () => {
  const alice = { id: 'c1', scopes: ['conversations:read', 'conversations:operate'], principal: { subject: 'alice' } } as unknown as Connection
  const aliceReadOnly = { id: 'c2', scopes: ['conversations:read'], principal: { subject: 'alice' } } as unknown as Connection
  const anonymous = { id: 'c3', scopes: ['conversations:read', 'conversations:operate'], principal: null } as unknown as Connection

  beforeEach(() => { person.enabled = true; person.subscription.mockClear(); person.select.mockClear(); person.refresh.mockClear() })

  it('keep the published phone actions at admin and add own-subscription actions for the person asking', () => {
    expect(PROVIDER_ACTIONS['provider.selectSubscription'].requiredScope).toBe('admin')
    expect(PROVIDER_ACTIONS['provider.refreshSubscription'].requiredScope).toBe('admin')
    expect(PROVIDER_ACTIONS['provider.selectOwnSubscription'].requiredScope).toBe('conversations:operate')
    expect(PROVIDER_ACTIONS['provider.refreshOwnSubscription'].requiredScope).toBe('conversations:operate')
  })

  it('answer a person from their own subscription, by the subject on their connection, never one they name', async () => {
    const read = await PROVIDER_ACTIONS['provider.subscription'].handler(alice, [{ subject: 'mallory' }])
    expect(read).toEqual({ ok: true, value: { ok: true, subscription: { state: 'applied', who: 'alice' } } })
    await PROVIDER_ACTIONS['provider.selectOwnSubscription'].handler(alice, [{ id: 'sub-high', subject: 'mallory' }])
    expect(person.select).toHaveBeenCalledWith('alice', { id: 'sub-high', subject: 'mallory' })
    await PROVIDER_ACTIONS['provider.refreshOwnSubscription'].handler(alice, [])
    expect(person.refresh).toHaveBeenCalledWith('alice')
  })

  it('let a person without admin choose their own subscription when the server runs the per-person lookup', async () => {
    const outcome = await PROVIDER_ACTIONS['provider.selectOwnSubscription'].handler(alice, [{ id: 'x' }])
    expect(outcome.ok).toBe(true)
  })

  it('refuse a connection with no signed-in person', async () => {
    const outcome = await PROVIDER_ACTIONS['provider.selectOwnSubscription'].handler(anonymous, [{ id: 'x' }])
    expect(outcome).toMatchObject({ ok: false, error: { code: 'scope' } })
    expect(person.select).not.toHaveBeenCalled()
  })

  it('fall back to the engine\'s lookup, and its admin rule, when this server runs no per-person lookup', async () => {
    person.enabled = false
    const read = await PROVIDER_ACTIONS['provider.subscription'].handler(alice, [])
    expect(read).toEqual({ ok: true, value: { ok: true, subscription: { state: 'engine' } } })
    const refused = await PROVIDER_ACTIONS['provider.selectOwnSubscription'].handler(alice, [{ id: 'x' }])
    expect(refused).toMatchObject({ ok: false, error: { code: 'scope', message: 'provider.selectOwnSubscription requires scope admin' } })
    const admin = { id: 'c4', scopes: ['admin'], principal: { subject: 'root' } } as unknown as Connection
    const allowed = await PROVIDER_ACTIONS['provider.selectOwnSubscription'].handler(admin, [{ id: 'x' }])
    expect(allowed).toEqual({ ok: true, value: { ok: true, subscription: { state: 'engine-selected' } } })
    expect(person.select).not.toHaveBeenCalled()
  })

  it('read the per-person state with only conversations:read', async () => {
    const outcome = await PROVIDER_ACTIONS['provider.subscription'].handler(aliceReadOnly, [])
    expect(outcome.ok).toBe(true)
  })
})
