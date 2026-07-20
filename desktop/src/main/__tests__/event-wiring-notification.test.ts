/**
 * event-wiring — engine_notification field mapping and push forwarding
 *
 * Regression tests for issue #282:
 *
 * Bug 1: The engine_notification handler read event.notificationTitle /
 * notificationBody / notificationLevel — fields that never existed on the
 * engine EngineEvent wire type (real fields: notifyTitle / notifyBody /
 * notifyKind per engine_event.go json tags). The handler has logged
 * "title=undefined level=undefined" since the notifications-panel feature
 * shipped.
 *
 * Bug 2: engine_notification with push:true was forwarded to remoteTransport
 * with push=false (the default), silently dropping APNs intent for every
 * ctx.notify() call. The relay only checks the outer frame push flag; the
 * engine's push:true field rides inside the encrypted payload the relay
 * cannot see.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const {
  mockSend,
  mockBroadcast,
  mockState,
  capturedHandler,
} = vi.hoisted(() => {
  const mockSend = vi.fn()
  const mockBroadcast = vi.fn()
  const mockState = {
    remoteTransport: { send: mockSend } as any,
    mainWindow: null,
  }
  const capturedHandler = { fn: null as ((key: string, event: any) => void) | null }
  return { mockSend, mockBroadcast, mockState, capturedHandler }
})

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
  forwardedEnginePermissionDenials: new Set(),
  lastForwardedTabStatus: new Map(),
}))

vi.mock('../broadcast', () => ({ broadcast: mockBroadcast }))
vi.mock('../settings-store', () => ({ shouldStreamThinkingToRemote: vi.fn(() => false) }))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() }))
vi.mock('../../shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))
vi.mock('../event-wiring-resources', () => ({
  subscribeToResourceKinds: vi.fn(() => Promise.resolve()),
  subscribeToGlobalResourceKinds: vi.fn(() => Promise.resolve()),
  clearResourceSubscriptions: vi.fn(),
  markReadPersisted: vi.fn(),
  resubscribeSessionResourceKinds: vi.fn(() => Promise.resolve()),
}))
vi.mock('../event-wiring-intercept', () => ({ handleInterceptEvent: vi.fn() }))
vi.mock('../event-wiring-disk-seed', () => ({ injectDiskResourcesIfEmpty: vi.fn() }))
vi.mock('../event-wiring-text-delta-batcher', () => ({
  accumulateTextDelta: vi.fn(),
  flushKeyDeltas: vi.fn(),
  dropKeyDeltas: vi.fn(),
}))
vi.mock('../event-wiring-provider-login', () => ({
  handleProviderLoginEvent: vi.fn(),
  handleProvidersUpdatedEvent: vi.fn(),
}))
vi.mock('../atv-window-manager', () => ({ notifyAtvPermissionResolved: vi.fn() }))

import { wireEngineBridgeEvents } from '../event-wiring'

describe('event-wiring: engine_notification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wireEngineBridgeEvents()
  })

  function emit(key: string, event: any) {
    if (!capturedHandler.fn) throw new Error('handler not captured')
    capturedHandler.fn(key, event)
  }

  it('maps notifyTitle/notifyBody/notifyKind to notificationTitle/notificationBody/notificationLevel in broadcastNormalized', () => {
    emit('tab1', {
      type: 'engine_notification',
      push: false,
      pushTitle: '',
      pushBody: '',
      notifyKind: 'briefing',
      notifyTitle: 'Daily briefing',
      notifyBody: 'Your summary is ready.',
      notifyResourceId: 'res-1',
    })

    // broadcast('ion:normalized-event', tabId, normalizedEvent)
    const calls = mockBroadcast.mock.calls.filter((args: unknown[]) => args[0] === 'ion:normalized-event')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    const normalizedEvent = calls[calls.length - 1][2]

    expect(normalizedEvent.type).toBe('engine_notification')
    expect(normalizedEvent.notificationTitle).toBe('Daily briefing')
    expect(normalizedEvent.notificationBody).toBe('Your summary is ready.')
    // notifyKind maps to notificationLevel
    expect(normalizedEvent.notificationLevel).toBe('briefing')

    // Old broken field names must not appear as undefined strings
    expect(normalizedEvent.notificationTitle).not.toBe('undefined')
    expect(normalizedEvent.notificationLevel).not.toBe('undefined')
  })

  it('sends to remoteTransport without push when event.push is false (iOS stays in sync while connected)', () => {
    emit('tab1', {
      type: 'engine_notification',
      push: false,
      pushTitle: 'Test',
      pushBody: 'Body',
      notifyKind: 'info',
      notifyTitle: 'Test notification',
      notifyBody: 'Test body',
    })

    // The non-push frame is still forwarded to iOS so connected devices stay
    // in sync. Push flag must be false (default).
    expect(mockSend).toHaveBeenCalledTimes(1)
    const [_event, pushFlag] = mockSend.mock.calls[0]
    expect(pushFlag).toBeFalsy()
  })

  it('sends to remoteTransport with push=true when event.push is true', () => {
    emit('tab1', {
      type: 'engine_notification',
      push: true,
      pushTitle: 'Reminder',
      pushBody: 'Check your briefing',
      notifyKind: 'reminder',
      notifyTitle: 'Reminder',
      notifyBody: 'Check your briefing',
      notifyResourceId: 'res-2',
    })

    expect(mockSend).toHaveBeenCalledTimes(1)
    const [_event, pushFlag, pushMeta] = mockSend.mock.calls[0]
    expect(pushFlag).toBe(true)
    expect(pushMeta?.title).toBe('Reminder')
    expect(pushMeta?.body).toBe('Check your briefing')
  })

  it('falls back to notifyTitle/notifyBody when pushTitle/pushBody are empty', () => {
    emit('tab1', {
      type: 'engine_notification',
      push: true,
      pushTitle: '',
      pushBody: '',
      notifyKind: 'alert',
      notifyTitle: 'Alert from extension',
      notifyBody: 'Something happened',
    })

    const [_event, pushFlag, pushMeta] = mockSend.mock.calls[0]
    expect(pushFlag).toBe(true)
    expect(pushMeta?.title).toBe('Alert from extension')
    expect(pushMeta?.body).toBe('Something happened')
  })

  it('does not send to remoteTransport when there is no remote transport', () => {
    mockState.remoteTransport = null as any

    emit('tab1', {
      type: 'engine_notification',
      push: true,
      pushTitle: 'Push',
      pushBody: 'Body',
      notifyKind: 'info',
      notifyTitle: 'Push',
      notifyBody: 'Body',
    })

    expect(mockSend).not.toHaveBeenCalled()

    // Restore for other tests
    mockState.remoteTransport = { send: mockSend } as any
  })
})
