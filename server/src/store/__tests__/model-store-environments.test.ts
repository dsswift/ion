// @vitest-environment jsdom
/**
 * The model store holds one catalog per Environment (ADR-033 union store):
 * a remote fetch asks that Environment's server and never touches the local
 * slice, login events are keyed by the Environment they came from, and a
 * remote browser-callback login is abandoned with a message instead of a
 * dead browser tab.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  rDebug: vi.fn(),
  listModels: vi.fn(),
  openExternal: vi.fn(),
  providerLoginCancel: vi.fn(),
  loginListener: null as null | ((u: unknown, environmentId?: string) => void),
  modelsUpdatedListener: null as null | ((environmentId?: string) => void),
}))

vi.mock('../rendererLogger', () => ({ rDebug: mocks.rDebug }))
vi.mock('../host-api', () => ({
  echoUserTurnToStudio: vi.fn(),
  listModels: mocks.listModels,
  on: (_channel: string, cb: (environmentId?: string) => void) => { mocks.modelsUpdatedListener = cb },
  onProviderLoginEvent: (cb: (u: unknown, environmentId?: string) => void) => { mocks.loginListener = cb; return () => {} },
  openExternal: mocks.openExternal,
  providerLoginCancel: mocks.providerLoginCancel,
}))

import { useModelStore, setupModelSync, environmentModels, REMOTE_BROWSER_LOGIN_REFUSAL, canStartProviderLogin } from '../model-store'

const localModels = [{ id: 'local-m', providerId: 'anthropic' }]
const groverModels = [{ id: 'grover-m', providerId: 'openai' }]

beforeEach(() => {
  vi.clearAllMocks()
  useModelStore.setState({ models: [], providers: [], loading: false, lastFetched: 0, byEnvironment: {}, loginStates: {}, onHost: { local: true } })
  mocks.listModels.mockImplementation(async (environmentId?: string) =>
    environmentId === 'grover'
      ? { models: groverModels, providers: [{ id: 'openai', hasAuth: true, backend: 'codex' }] }
      : { models: localModels, providers: [{ id: 'anthropic', hasAuth: true }] })
})

describe('per-environment catalogs', () => {
  it('fetches a remote environment into its own slice and leaves local alone', async () => {
    await useModelStore.getState().fetchModelsFor('grover')
    expect(mocks.listModels).toHaveBeenCalledWith('grover')
    const s = useModelStore.getState()
    expect(s.models).toEqual([])
    expect(s.modelsFor('grover')).toEqual(groverModels)
    expect(environmentModels(s, 'grover').providers[0].id).toBe('openai')
    expect(s.findModelIn('grover', 'grover-m')?.id).toBe('grover-m')
    expect(s.findModel('grover-m')).toBeUndefined()
    expect(s.isModelCliServedIn('grover', 'grover-m')).toBe(true)
    expect(s.isModelCliServed('grover-m')).toBe(false)
  })

  it('fetchModels fills the top-level local slice and environmentModels reads it back', async () => {
    await useModelStore.getState().fetchModels()
    expect(mocks.listModels).toHaveBeenCalledWith('local')
    const s = useModelStore.getState()
    expect(s.models).toEqual(localModels)
    expect(environmentModels(s, 'local').models).toBe(s.models)
    expect(s.byEnvironment.local).toBeUndefined()
  })

  it('coalesces a fetch already in flight for the same environment', async () => {
    let release: (v: { models: unknown[]; providers: unknown[] }) => void = () => {}
    mocks.listModels.mockImplementationOnce(() => new Promise((r) => { release = r }))
    const first = useModelStore.getState().fetchModelsFor('grover')
    const second = useModelStore.getState().fetchModelsFor('grover')
    release({ models: groverModels, providers: [] })
    await Promise.all([first, second])
    expect(mocks.listModels).toHaveBeenCalledTimes(1)
  })
})

describe('setupModelSync per environment', () => {
  it('refetches the environment a models-updated signal names and keys login state by environment', async () => {
    setupModelSync()
    await Promise.resolve()
    mocks.listModels.mockClear()
    mocks.modelsUpdatedListener?.('grover')
    await new Promise((r) => setTimeout(r, 0))
    expect(mocks.listModels).toHaveBeenCalledWith('grover')

    mocks.loginListener?.({ provider: 'openai', backend: 'codex', stage: 'started' }, 'grover')
    expect(useModelStore.getState().loginStateFor('grover', 'openai')?.phase).toBe('waiting')
    expect(useModelStore.getState().loginStateFor('local', 'openai')).toBeUndefined()

    mocks.loginListener?.({ provider: 'openai', backend: 'codex', stage: 'await_device_code', userCode: 'ABCD', verificationUrl: 'https://v' }, 'grover')
    expect(useModelStore.getState().loginStateFor('grover', 'openai')?.userCode).toBe('ABCD')
    expect(mocks.openExternal).toHaveBeenCalledWith('https://v')
  })

  it('abandons a remote browser-callback login with a message and cancels it on that environment', () => {
    setupModelSync()
    mocks.loginListener?.({ provider: 'xai', backend: 'grok', stage: 'await_browser', authUrl: 'http://127.0.0.1:5555/cb' }, 'grover')
    expect(useModelStore.getState().loginStateFor('grover', 'xai')).toEqual({ phase: 'error', error: REMOTE_BROWSER_LOGIN_REFUSAL })
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(mocks.providerLoginCancel).toHaveBeenCalledWith('xai', 'grover')
  })

  it('abandons a browser-callback login on the local environment id when the server said this client is not on its host', () => {
    // A browser attached to a headless server keeps the local environment id.
    useModelStore.getState().setEnvironmentOnHost('local', false)
    setupModelSync()
    mocks.loginListener?.({ provider: 'xai', backend: 'grok', stage: 'await_browser', authUrl: 'http://127.0.0.1:5555/cb' }, 'local')
    expect(useModelStore.getState().loginStateFor('local', 'xai')).toEqual({ phase: 'error', error: REMOTE_BROWSER_LOGIN_REFUSAL })
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(mocks.providerLoginCancel).toHaveBeenCalledWith('xai', 'local')
  })

  it('opens the browser for a LOCAL await_browser and lets a remote claude-code pasted-code flow proceed', () => {
    setupModelSync()
    mocks.loginListener?.({ provider: 'xai', backend: 'grok', stage: 'await_browser', authUrl: 'https://x' }, 'local')
    expect(mocks.openExternal).toHaveBeenCalledWith('https://x')
    mocks.loginListener?.({ provider: 'anthropic', backend: 'claude-code', stage: 'await_browser', authUrl: 'https://fallback' }, 'grover')
    expect(useModelStore.getState().loginStateFor('grover', 'anthropic')).toEqual({ phase: 'waiting', url: 'https://fallback' })
    expect(mocks.providerLoginCancel).not.toHaveBeenCalled()
  })
})

describe('canStartProviderLogin', () => {
  it('refuses only host-only flows, and only off the host', () => {
    expect(canStartProviderLogin(false, { loginFlow: 'browser-callback' })).toBe(false)
    expect(canStartProviderLogin(false, { loginFlow: 'browser-code' })).toBe(true)
    expect(canStartProviderLogin(false, { loginFlow: 'browser-or-device-code' })).toBe(true)
    expect(canStartProviderLogin(false, {})).toBe(true)
    expect(canStartProviderLogin(true, { loginFlow: 'browser-callback' })).toBe(true)
  })
})
