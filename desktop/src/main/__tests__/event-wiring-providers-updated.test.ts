/**
 * event-wiring — engine_providers_updated forwarding
 *
 * Pins the fix for "Sign out does nothing" and "no OpenAI models after a
 * delegated-CLI auth change": the advisory engine_providers_updated event must
 * trigger a model-cache refresh so the picker and the CLI sign-in/out controls
 * re-read provider auth state. Without the handler this test fails.
 *
 * Harness mirrors event-wiring-provider-login.test.ts.
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
vi.mock('../settings-store', () => ({ shouldStreamThinkingToRemote: vi.fn(() => true) }))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))
vi.mock('../ipc/models', () => ({ refreshModelCache: refreshMock }))

import { wireEngineBridgeEvents } from '../event-wiring'

function emit(key: string, event: any): void {
  capturedHandler.fn!(key, event)
}

describe('wireEngineBridgeEvents — engine_providers_updated', () => {
  beforeEach(() => {
    mockBroadcast.mockClear()
    refreshMock.mockClear()
    capturedHandler.fn = null
    wireEngineBridgeEvents()
    expect(capturedHandler.fn).toBeTruthy()
  })

  it('refreshes the model cache when providers are updated', () => {
    emit('', { type: 'engine_providers_updated' })
    expect(refreshMock).toHaveBeenCalledTimes(1)
  })

  it('does not refresh for unrelated engine events', () => {
    emit('', { type: 'engine_text_delta', text: 'hi' })
    expect(refreshMock).not.toHaveBeenCalled()
  })
})
