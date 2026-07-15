/**
 * Provider auth IPC handlers. Handlers are captured from a mocked ipcMain and
 * invoked directly; the engine bridge is mocked. (The former
 * PROVIDER_SET_BACKEND handler is gone — backends are credential-derived by
 * the engine's hybrid routing, with no desktop selector.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { handlers, bridge } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  bridge: {
    providerLogin: vi.fn(async () => ({ ok: true })),
    providerLoginCancel: vi.fn(async () => ({ ok: true })),
    providerLogout: vi.fn(async () => ({ ok: true })),
  },
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn)),
    on: vi.fn(),
  },
}))
vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../state', () => ({ engineBridge: bridge }))

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
