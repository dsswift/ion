/**
 * Provider auth + backend-preference IPC handlers. Handlers are captured from a
 * mocked ipcMain and invoked directly; the engine bridge and the relaunch
 * helper are mocked so the config mutation can be inspected without restarting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { handlers, bridge, relaunchMock, engineConfig } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  bridge: {
    providerLogin: vi.fn(async () => ({ ok: true })),
    providerLoginCancel: vi.fn(async () => ({ ok: true })),
    providerLogout: vi.fn(async () => ({ ok: true })),
  },
  relaunchMock: vi.fn(),
  engineConfig: { value: {} as Record<string, any> },
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)),
    on: vi.fn(),
  },
}))
vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../state', () => ({ engineBridge: bridge }))
vi.mock('../../settings-store', () => ({ readEngineConfig: () => engineConfig.value }))
vi.mock('../../engine-restart', () => ({
  // Run the mutate against a deep copy of the current config so the test can
  // inspect the resulting shape.
  writeConfigAndRelaunch: async (mutate: (cfg: Record<string, any>) => void) => {
    const cfg = JSON.parse(JSON.stringify(engineConfig.value))
    mutate(cfg)
    relaunchMock(cfg)
  },
}))

import { registerProvidersIpc } from '../providers'
import { IPC } from '../../../shared/types'

registerProvidersIpc()

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({}, ...args)
}

beforeEach(() => {
  vi.clearAllMocks()
  engineConfig.value = {}
})

describe('provider auth IPC', () => {
  it('forwards provider_login to the engine bridge', async () => {
    await invoke(IPC.PROVIDER_LOGIN, { provider: 'openai' })
    expect(bridge.providerLogin).toHaveBeenCalledWith('openai')
  })

  it('forwards provider_logout to the engine bridge', async () => {
    await invoke(IPC.PROVIDER_LOGOUT, { provider: 'openai' })
    expect(bridge.providerLogout).toHaveBeenCalledWith('openai')
  })
})

describe('PROVIDER_SET_BACKEND', () => {
  it('enables hybrid and pins providers, changing only the target', async () => {
    // Start from the default (top-level api → every provider effectively api).
    engineConfig.value = { backend: 'api' }
    await invoke(IPC.PROVIDER_SET_BACKEND, { provider: 'openai', backend: 'codex' })

    expect(relaunchMock).toHaveBeenCalledTimes(1)
    const cfg = relaunchMock.mock.calls[0][0]
    expect(cfg.backend).toBe('hybrid')
    // Target changed…
    expect(cfg.providers.openai.backend).toBe('codex')
    // …others pinned to their prior effective backend (all api under top api).
    expect(cfg.providers.anthropic.backend).toBe('api')
    expect(cfg.providers.xai.backend).toBe('api')
    expect(cfg.providers.cursor.backend).toBe('api')
  })

  it('preserves an existing claude-code top-level as the anthropic pin', async () => {
    engineConfig.value = { backend: 'claude-code' }
    await invoke(IPC.PROVIDER_SET_BACKEND, { provider: 'xai', backend: 'grok' })
    const cfg = relaunchMock.mock.calls[0][0]
    expect(cfg.backend).toBe('hybrid')
    expect(cfg.providers.anthropic.backend).toBe('claude-code') // was effective under claude-code top
    expect(cfg.providers.xai.backend).toBe('grok')
  })

  it('is a no-op when the provider already uses the selected backend', async () => {
    engineConfig.value = { backend: 'hybrid', providers: { openai: { backend: 'codex' } } }
    const res = (await invoke(IPC.PROVIDER_SET_BACKEND, { provider: 'openai', backend: 'codex' })) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it('rejects missing provider or backend', async () => {
    const res = (await invoke(IPC.PROVIDER_SET_BACKEND, { provider: '', backend: 'codex' })) as { ok: boolean }
    expect(res.ok).toBe(false)
  })
})
