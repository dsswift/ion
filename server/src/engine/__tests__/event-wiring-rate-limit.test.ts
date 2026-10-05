/**
 * event-wiring — engine_rate_limit renderer forwarding
 *
 * The engine reports a backend's usage limit state as engine_rate_limit.
 * event-wiring turns it into the normalized `rate_limit` event the store
 * consumes, with every window intact.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const {
  mockBroadcast,
  mockSend,
  mockState,
  mockPermDenialSet,
  mockLastStatusMap,
  capturedHandler,
} = vi.hoisted(() => {
  const mockBroadcast = vi.fn()
  const mockSend = vi.fn()
  const mockState = {
    mainWindow: null,
  }
  const mockPermDenialSet = new Set<string>()
  const mockLastStatusMap = new Map<string, string>()
  const capturedHandler = { fn: null as ((key: string, event: any) => void) | null }
  return { mockBroadcast, mockSend, mockState, mockPermDenialSet, mockLastStatusMap, capturedHandler }
})

// The `desktop_*` device transport is gone; a RemoteEvent now leaves the
// server through `sendRemoteEvent`, which fans it to thin Studio-wire
// clients. Capture there, and drive the "is anyone listening" gate with
// `remoteClientsPresent`.
const { mockClientsPresent } = vi.hoisted(() => ({ mockClientsPresent: vi.fn(() => true) }))

vi.mock('../../thin-view/remote-out', () => ({
  sendRemoteEvent: mockSend,
  remoteClientsPresent: mockClientsPresent,
  syncRemoteAttention: vi.fn(),
  thinConnections: vi.fn(() => []),
  sendThinEventTo: vi.fn(() => true),
}))

vi.mock('../../state', async (importOriginal) => ({ ...(await importOriginal()), ...{
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
  forwardedEnginePermissionDenials: mockPermDenialSet,
  lastForwardedTabStatus: mockLastStatusMap,
} }))

vi.mock('../../broadcast', () => ({ broadcast: mockBroadcast }))
vi.mock('../../persistence/settings-store', async (importOriginal) => ({ ...(await importOriginal()), ...{ shouldStreamThinkingToRemote: vi.fn(() => false) } }))
vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@ion/shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))

import { wireEngineBridgeEvents } from '../event-wiring'

function emit(key: string, event: any): void {
  capturedHandler.fn!(key, event)
}

describe('wireEngineBridgeEvents — engine_rate_limit forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler.fn = null
    mockClientsPresent.mockReturnValue(true)
    mockPermDenialSet.clear()
    mockLastStatusMap.clear()
    wireEngineBridgeEvents()
  })

  it('forwards the report as a normalized rate_limit event with its windows', () => {
    emit('tab1:inst1', {
      type: 'engine_rate_limit',
      rateLimit: {
        status: 'allowed',
        resetsAt: 1791048000,
        rateLimitType: 'five_hour',
        windows: {
          five_hour: { utilization: 0.24, resetsAt: 1791048000 },
          seven_day: { utilization: 0.64, resetsAt: 1791234000 },
        },
      },
    })

    const events = mockBroadcast.mock.calls
      .filter((c) => c[0] === 'ion:normalized-event' && c[2]?.type === 'rate_limit')
      .map((c) => c[2])
    expect(events).toHaveLength(1)
    expect(events[0].status).toBe('allowed')
    expect(events[0].rateLimitType).toBe('five_hour')
    expect(events[0].windows.seven_day).toEqual({ utilization: 0.64, resetsAt: 1791234000 })
  })
})
