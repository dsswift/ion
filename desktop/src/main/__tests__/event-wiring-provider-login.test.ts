/**
 * event-wiring — engine_provider_login forwarding
 *
 * Pins that a delegated-CLI login stage event is forwarded to the renderer on
 * the PROVIDER_LOGIN_EVENT channel, and that a completed stage triggers a model
 * cache refresh (so the provider flips to authed and its models appear).
 *
 * Harness mirrors event-wiring-dispatch-activity.test.ts.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const { mockBroadcast, mockState, capturedHandler, refreshMock } = vi.hoisted(() => ({
  mockBroadcast: vi.fn(),
  mockState: { remoteTransport: null as any, mainWindow: null },
  capturedHandler: { fn: null as ((key: string, event: any) => void) | null },
  refreshMock: vi.fn(async () => {}),
}))

vi.mock('../state', () => ({
  state: mockState,
  sessionPlane: { on: vi.fn(), emit: vi.fn(), notifyConversationCleared: vi.fn() },
  engineBridge: {
    on: vi.fn((event: string, handler: any) => {
      if (event === 'event') capturedHandler.fn = handler
    }),
    sendReconcileState: vi.fn(),
  },
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map(),
  extensionCommandRegistry: new Map(),
  forwardedEnginePermissionDenials: new Set<string>(),
  lastForwardedTabStatus: new Map<string, string>(),
}))
vi.mock('../broadcast', () => ({ broadcast: mockBroadcast }))
vi.mock('../settings-store', () => ({ currentBackend: 'test', shouldStreamThinkingToRemote: vi.fn(() => true) }))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))
vi.mock('../ipc/models', () => ({ refreshModelCache: refreshMock }))

import { wireEngineBridgeEvents } from '../event-wiring'
import { IPC } from '../../shared/types'

function emit(key: string, event: any): void {
  capturedHandler.fn!(key, event)
}

function loginBroadcasts() {
  return mockBroadcast.mock.calls.filter((c) => c[0] === IPC.PROVIDER_LOGIN_EVENT)
}

describe('wireEngineBridgeEvents — engine_provider_login', () => {
  beforeEach(() => {
    mockBroadcast.mockClear()
    refreshMock.mockClear()
    capturedHandler.fn = null
    wireEngineBridgeEvents()
    expect(capturedHandler.fn).toBeTruthy()
  })

  it('forwards each stage to the renderer and does not refresh mid-flow', () => {
    emit('', { type: 'engine_provider_login', providerLogin: { provider: 'openai', backend: 'codex', stage: 'await_browser', authUrl: 'https://x' } })
    const calls = loginBroadcasts()
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toMatchObject({ provider: 'openai', backend: 'codex', stage: 'await_browser', authUrl: 'https://x' })
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('refreshes the model cache when the login completes', () => {
    emit('', { type: 'engine_provider_login', providerLogin: { provider: 'openai', backend: 'codex', stage: 'completed' } })
    expect(loginBroadcasts()).toHaveLength(1)
    expect(refreshMock).toHaveBeenCalledTimes(1)
  })
})
