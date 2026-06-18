/**
 * event-wiring — extended-thinking projection gate (issue #158)
 *
 * Low-bandwidth mode, facet 1: the per-pairing `streamThinkingToRemote`
 * toggle (default ON) controls whether the desktop forwards the model's
 * per-token reasoning stream (`engine_thinking_delta`) to paired iOS
 * devices. The block BOUNDARIES (`engine_thinking_block_start` /
 * `engine_thinking_block_end`) must ALWAYS be forwarded so the phone shows
 * the "Thought for Ns" summary and never looks stalled mid-turn.
 *
 * These tests pin the forward path in `wireEngineBridgeEvents`:
 *
 *   - toggle ON  → all three thinking events reach `remoteTransport.send`.
 *   - toggle OFF → block_start / block_end forwarded; the delta is DROPPED.
 *
 * Wire-type contract: the thinking forward path constructs its envelope as
 * `send({ ...event, tabId, instanceId, type: engineToWireType(event.type) })`
 * — `...event` FIRST so the computed `desktop_thinking_*` wire type wins over
 * the engine's bare `engine_thinking_*` type. This is what lets iOS (whose
 * decoders key off `desktop_thinking_*`) actually receive the events. These
 * tests assert on the `desktop_thinking_*` wire types the phone decodes.
 *
 * The gate value is supplied by `shouldStreamThinkingToRemote()`, mocked
 * here so each test can flip the toggle without touching disk.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const {
  mockSend,
  mockState,
  mockPermDenialSet,
  mockLastStatusMap,
  capturedHandler,
  mockShouldStream,
} = vi.hoisted(() => {
  const mockSend = vi.fn()
  const mockState = {
    remoteTransport: { send: mockSend } as any,
    mainWindow: null,
  }
  const mockPermDenialSet = new Set<string>()
  const mockLastStatusMap = new Map<string, string>()
  const capturedHandler = { fn: null as ((key: string, event: any) => void) | null }
  // Default ON — tests flip it via mockReturnValue per case.
  const mockShouldStream = vi.fn(() => true)
  return {
    mockSend,
    mockState,
    mockPermDenialSet,
    mockLastStatusMap,
    capturedHandler,
    mockShouldStream,
  }
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
  activeToolInputs: new Map(),
  lastMessagePreview: new Map(),
  extensionCommandRegistry: new Map(),
  forwardedEnginePermissionDenials: mockPermDenialSet,
  lastForwardedEngineTabStatus: mockLastStatusMap,
}))

vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../settings-store', () => ({
  currentBackend: 'test',
  shouldStreamThinkingToRemote: mockShouldStream,
}))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))

import { wireEngineBridgeEvents } from '../event-wiring'

function emit(key: string, event: any): void {
  capturedHandler.fn!(key, event)
}

/** All forwarded wire messages whose type matches `wireType`. */
function sentOfType(wireType: string) {
  return mockSend.mock.calls.filter((c) => c[0]?.type === wireType)
}

// Compound key (`tabId:instanceId`) — the wire forward path keys off it for
// the tabId/instanceId split, but thinking events forward on any key.
const KEY = 'tab1:inst1'

describe('wireEngineBridgeEvents — thinking projection gate (issue #158)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler.fn = null
    mockState.remoteTransport = { send: mockSend } as any
    mockPermDenialSet.clear()
    mockLastStatusMap.clear()
    mockShouldStream.mockReturnValue(true)
    wireEngineBridgeEvents()
  })

  it('toggle ON: forwards block_start, delta, and block_end (all three)', () => {
    mockShouldStream.mockReturnValue(true)

    emit(KEY, { type: 'engine_thinking_block_start' })
    emit(KEY, { type: 'engine_thinking_delta', thinkingText: 'reasoning…' })
    emit(KEY, { type: 'engine_thinking_block_end', thinkingElapsedSeconds: 14, thinkingTotalTokens: 3200 })

    expect(sentOfType('desktop_thinking_block_start')).toHaveLength(1)
    expect(sentOfType('desktop_thinking_delta')).toHaveLength(1)
    expect(sentOfType('desktop_thinking_block_end')).toHaveLength(1)
  })

  it('toggle ON: the forwarded delta carries the reasoning text', () => {
    mockShouldStream.mockReturnValue(true)

    emit(KEY, { type: 'engine_thinking_delta', thinkingText: 'step one' })

    const deltas = sentOfType('desktop_thinking_delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0][0].thinkingText).toBe('step one')
    // The split tabId/instanceId ride along so iOS can scope the row.
    expect(deltas[0][0].tabId).toBe('tab1')
    expect(deltas[0][0].instanceId).toBe('inst1')
  })

  it('toggle OFF: forwards block_start and block_end but DROPS the delta', () => {
    mockShouldStream.mockReturnValue(false)

    emit(KEY, { type: 'engine_thinking_block_start' })
    emit(KEY, { type: 'engine_thinking_delta', thinkingText: 'reasoning…' })
    emit(KEY, { type: 'engine_thinking_block_end', thinkingElapsedSeconds: 14, thinkingTotalTokens: 3200 })

    // Boundaries always forwarded so the phone shows the summary.
    expect(sentOfType('desktop_thinking_block_start')).toHaveLength(1)
    expect(sentOfType('desktop_thinking_block_end')).toHaveLength(1)
    // Delta dropped to save bandwidth.
    expect(sentOfType('desktop_thinking_delta')).toHaveLength(0)
  })

  it('toggle OFF: a burst of deltas is fully suppressed, boundaries survive', () => {
    mockShouldStream.mockReturnValue(false)

    emit(KEY, { type: 'engine_thinking_block_start' })
    for (let i = 0; i < 10; i++) {
      emit(KEY, { type: 'engine_thinking_delta', thinkingText: `tok${i}` })
    }
    emit(KEY, { type: 'engine_thinking_block_end', thinkingElapsedSeconds: 2 })

    expect(sentOfType('desktop_thinking_delta')).toHaveLength(0)
    expect(sentOfType('desktop_thinking_block_start')).toHaveLength(1)
    expect(sentOfType('desktop_thinking_block_end')).toHaveLength(1)
  })

  it('the gate is consulted ONLY for deltas, never for the boundaries', () => {
    mockShouldStream.mockReturnValue(true)

    emit(KEY, { type: 'engine_thinking_block_start' })
    expect(mockShouldStream).not.toHaveBeenCalled()

    emit(KEY, { type: 'engine_thinking_block_end', thinkingElapsedSeconds: 1 })
    expect(mockShouldStream).not.toHaveBeenCalled()

    emit(KEY, { type: 'engine_thinking_delta', thinkingText: 'x' })
    expect(mockShouldStream).toHaveBeenCalledTimes(1)
  })

  it('does not forward any thinking event when remoteTransport is null', () => {
    mockState.remoteTransport = null

    emit(KEY, { type: 'engine_thinking_block_start' })
    emit(KEY, { type: 'engine_thinking_delta', thinkingText: 'x' })
    emit(KEY, { type: 'engine_thinking_block_end' })

    expect(mockSend).not.toHaveBeenCalled()
  })
})
