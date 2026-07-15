/**
 * event-wiring — generic engine-event wire-type forwarding
 *
 * Regression test for the desktop→iOS double-render bug: the generic engine-
 * event forwarder in `wireEngineBridgeEvents` built its wire envelope with the
 * WRONG object-spread order:
 *
 *   send({ type: engineToWireType(event.type), tabId, instanceId, ...event })
 *
 * Because `...event` was spread LAST and every engine event carries its own
 * `type: 'engine_*'`, the spread clobbered the computed `desktop_*` wire type
 * back to the raw `engine_*` name. iOS `TypeKey` (NormalizedEvent.swift) only
 * decodes `desktop_*` names, so the event threw `Cannot initialize TypeKey from
 * invalid String value engine_*` and was dropped on the phone — including
 * `engine_message_end`, which left the streamed assistant message un-sealed and
 * produced a duplicate block when the canonical history copy arrived later.
 *
 * The fix reorders the spread to match the (already-correct) thinking path:
 *
 *   send({ ...event, tabId, instanceId, type: engineToWireType(event.type) })
 *
 * so the computed `desktop_*` type wins. These tests pin that contract: every
 * engine event forwarded through the generic branch reaches iOS with its
 * `desktop_*` wire type, and NO forwarded message retains a raw `engine_*` type.
 *
 * Harness mirrors event-wiring-thinking.test.ts (same vi.hoisted mock block,
 * same captured `engineBridge.'event'` handler, same `sentOfType` helper).
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
  lastMessagePreview: new Map(),
  extensionCommandRegistry: new Map(),
  forwardedEnginePermissionDenials: mockPermDenialSet,
  lastForwardedTabStatus: mockLastStatusMap,
}))

vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../settings-store', () => ({
  shouldStreamThinkingToRemote: mockShouldStream,
}))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))

import { wireEngineBridgeEvents } from '../event-wiring'

function emit(key: string, event: any): void {
  capturedHandler.fn!(key, event)
}

/** All forwarded wire messages whose type matches `wireType`. */
function sentOfType(wireType: string) {
  return mockSend.mock.calls.filter((c) => c[0]?.type === wireType)
}

/** Every distinct `type` string the forwarder sent across all calls. */
function allSentTypes(): string[] {
  return mockSend.mock.calls.map((c) => c[0]?.type).filter((t): t is string => typeof t === 'string')
}

// Compound key (`tabId:instanceId`) — the forwarder splits it for the
// tabId/instanceId ride-along.
const KEY = 'tab1:inst1'

describe('wireEngineBridgeEvents — generic engine-event wire type', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler.fn = null
    mockState.remoteTransport = { send: mockSend } as any
    mockPermDenialSet.clear()
    mockLastStatusMap.clear()
    mockShouldStream.mockReturnValue(true)
    wireEngineBridgeEvents()
  })

  it('forwards engine_message_end as desktop_message_end (not engine_message_end)', () => {
    emit(KEY, {
      type: 'engine_message_end',
      usage: { inputTokens: 100, outputTokens: 20, contextPercent: 12, cost: 0.003 },
    })

    // The fix: the computed desktop_ wire type must win over `...event`'s
    // raw engine_ type. Pre-fix this sent `engine_message_end` and iOS
    // dropped it (TypeKey decode failure), leaving the assistant message
    // un-sealed → duplicate render.
    expect(sentOfType('desktop_message_end')).toHaveLength(1)
    expect(sentOfType('engine_message_end')).toHaveLength(0)
  })

  it('the forwarded message_end carries the usage payload and split tabId/instanceId', () => {
    emit(KEY, {
      type: 'engine_message_end',
      usage: { inputTokens: 100, outputTokens: 20, contextPercent: 12, cost: 0.003 },
    })

    const sent = sentOfType('desktop_message_end')
    expect(sent).toHaveLength(1)
    expect(sent[0][0].usage).toEqual({ inputTokens: 100, outputTokens: 20, contextPercent: 12, cost: 0.003 })
    expect(sent[0][0].tabId).toBe('tab1')
    expect(sent[0][0].instanceId).toBe('inst1')
  })

  it('forwards engine_status as desktop_status (not engine_status)', () => {
    emit(KEY, { type: 'engine_status', fields: { state: 'running' } })

    expect(sentOfType('desktop_status')).toHaveLength(1)
    expect(sentOfType('engine_status')).toHaveLength(0)
  })

  it('forwards engine_session_status as desktop_session_status', () => {
    emit(KEY, { type: 'engine_session_status', sessionStatus: { state: 'running' } })

    expect(sentOfType('desktop_session_status')).toHaveLength(1)
    expect(sentOfType('engine_session_status')).toHaveLength(0)
  })

  it('forwards engine_agent_state as desktop_agent_state', () => {
    emit(KEY, { type: 'engine_agent_state', agents: [] })

    expect(sentOfType('desktop_agent_state')).toHaveLength(1)
    expect(sentOfType('engine_agent_state')).toHaveLength(0)
  })

  it('preserves the special-cased wire names from engineToWireType', () => {
    emit(KEY, { type: 'engine_error', message: 'boom' })
    emit(KEY, { type: 'engine_profiles', profiles: [] })

    // engineToWireType maps these to a non-default form; the reorder must
    // not regress them.
    expect(sentOfType('desktop_engine_error')).toHaveLength(1)
    expect(sentOfType('desktop_engine_profiles')).toHaveLength(1)
  })

  it('never forwards any message with a raw engine_ wire type', () => {
    emit(KEY, { type: 'engine_message_end', usage: { inputTokens: 1, outputTokens: 1, contextPercent: 0, cost: 0 } })
    emit(KEY, { type: 'engine_status', fields: { state: 'idle' } })
    emit(KEY, { type: 'engine_session_status', sessionStatus: { state: 'idle' } })
    emit(KEY, { type: 'engine_agent_state', agents: [] })
    emit(KEY, { type: 'engine_working_message', message: 'thinking' })
    emit(KEY, { type: 'engine_model_override', model: 'claude' })

    const rawEngineTypes = allSentTypes().filter((t) => t.startsWith('engine_'))
    expect(rawEngineTypes).toEqual([])
  })

  it('does not forward when remoteTransport is null', () => {
    mockState.remoteTransport = null

    emit(KEY, { type: 'engine_message_end', usage: { inputTokens: 1, outputTokens: 1, contextPercent: 0, cost: 0 } })

    expect(mockSend).not.toHaveBeenCalled()
  })
})
