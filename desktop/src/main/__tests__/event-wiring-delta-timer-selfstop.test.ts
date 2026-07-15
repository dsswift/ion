/**
 * event-wiring — deltaFlushTimer self-stop
 *
 * The 16ms (~62.5Hz) text-delta flush timer used to run for the whole process
 * lifetime once the first stream started: ensureDeltaFlushTimer() armed it and
 * nothing ever cleared it, so it woke the event loop 62.5 times/sec forever,
 * flushing an empty buffer at idle.
 *
 * Fix: flushTextDeltas() clears the interval when the buffer is empty; the next
 * engine_text_delta re-arms it via ensureDeltaFlushTimer(). These tests measure
 * the fake-timer count delta around an idle flush. On the pre-fix code the timer
 * is never cleared, so the count stays elevated and the first assertion goes red.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const { mockSend, mockState, capturedHandler } = vi.hoisted(() => {
  const mockSend = vi.fn()
  const mockState = {
    remoteTransport: { send: mockSend } as any,
    mainWindow: null,
  }
  const capturedHandler = { fn: null as ((key: string, event: any) => void) | null }
  return { mockSend, mockState, capturedHandler }
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
  forwardedEnginePermissionDenials: new Set<string>(),
  lastForwardedTabStatus: new Map<string, string>(),
}))

vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../settings-store', () => ({ currentBackend: 'test', shouldStreamThinkingToRemote: vi.fn(() => false) }))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))
vi.mock('../event-wiring-resources', () => ({
  subscribeToResourceKinds: vi.fn(() => Promise.resolve()),
  subscribeToGlobalResourceKinds: vi.fn(() => Promise.resolve()),
  clearResourceSubscriptions: vi.fn(),
  markReadPersisted: vi.fn(),
  resubscribeSessionResourceKinds: vi.fn(() => Promise.resolve()),
  wireTabFocusHandler: vi.fn(),
  wireMarkResourceReadHandler: vi.fn(),
  wireDeleteResourceHandler: vi.fn(),
}))
vi.mock('../event-wiring-intercept', () => ({ handleInterceptEvent: vi.fn(() => Promise.resolve()) }))
vi.mock('../event-wiring-disk-seed', () => ({ injectDiskResourcesIfEmpty: vi.fn() }))

import { wireEngineBridgeEvents } from '../event-wiring'

function emit(key: string, event: any): void {
  capturedHandler.fn!(key, event)
}

function deltaCount(): number {
  return mockSend.mock.calls.filter((c) => (c[0] as any)?.type === 'desktop_text_delta').length
}

describe('wireEngineBridgeEvents — deltaFlushTimer self-stop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    capturedHandler.fn = null
    mockState.remoteTransport = { send: mockSend } as any
    wireEngineBridgeEvents()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears the timer when the buffer drains and re-arms on the next delta', () => {
    const base = vi.getTimerCount()

    // First delta arms the 16ms flush timer.
    emit('tab1', { type: 'engine_text_delta', text: 'hello' })
    expect(vi.getTimerCount()).toBe(base + 1)

    // Tick once: flushes the buffered text to iOS.
    vi.advanceTimersByTime(16)
    expect(deltaCount()).toBe(1)

    // Tick again with an empty buffer: the timer self-stops.
    vi.advanceTimersByTime(16)
    expect(vi.getTimerCount()).toBe(base)

    // A new delta re-arms the timer and flushes on the next tick.
    emit('tab1', { type: 'engine_text_delta', text: 'world' })
    expect(vi.getTimerCount()).toBe(base + 1)
    vi.advanceTimersByTime(16)
    expect(deltaCount()).toBe(2)
  })
})
