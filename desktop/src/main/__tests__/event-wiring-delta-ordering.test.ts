/**
 * event-wiring — desktop_text_delta ordering guarantee
 *
 * Regression test for the post-#256 "iOS streaming stalls after first turn" bug.
 *
 * Root cause: engine_text_delta events are batched into a 16ms setInterval
 * buffer for efficiency. engine_message_end is forwarded IMMEDIATELY by the
 * generic forwarder in the same event handler. When both arrive in the same
 * event-loop tick the message_end entered the FIFO transport queue BEFORE the
 * final text batch — iOS received the seal event first, then the tail text
 * arrived after the seal and created a spurious extra assistant message.
 *
 * Fix: flushKeyDeltas(key) is called synchronously before forwarding
 * engine_message_end and engine_tool_start so the batched desktop_text_delta
 * enters the transport queue BEFORE the boundary event.
 *
 * These tests verify the ordering contract. They go RED if the pre-send flush
 * is removed and the 16ms timer is the only flush path.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

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
vi.mock('../settings-store', () => ({ shouldStreamThinkingToRemote: vi.fn(() => false) }))
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

// Return the ordered sequence of type strings sent to remoteTransport.send
function sentTypes(): string[] {
  return mockSend.mock.calls.map((c) => (c[0] as any)?.type as string)
}

describe('wireEngineBridgeEvents — desktop_text_delta ordering vs. seal events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler.fn = null
    mockState.remoteTransport = { send: mockSend } as any
    wireEngineBridgeEvents()
  })

  it('sends desktop_text_delta BEFORE desktop_message_end when both arrive in the same tick', () => {
    // Emit a text delta then message_end in the same synchronous tick.
    // Without the flushKeyDeltas fix the 16ms timer is the only flush path,
    // so message_end would be sent first (immediately) and the text delta
    // would be sent later (on the next timer tick). With the fix, the pre-send
    // flush in the generic forwarder ensures correct FIFO ordering.
    emit('tab1', { type: 'engine_text_delta', text: 'hello world' })
    emit('tab1', { type: 'engine_message_end', usage: { inputTokens: 10, outputTokens: 5 } })

    const types = sentTypes()
    const deltaIdx = types.indexOf('desktop_text_delta')
    const endIdx = types.indexOf('desktop_message_end')

    expect(deltaIdx).toBeGreaterThanOrEqual(0)
    expect(endIdx).toBeGreaterThanOrEqual(0)
    expect(deltaIdx).toBeLessThan(endIdx)
  })

  it('sends desktop_text_delta BEFORE desktop_tool_start when both arrive in the same tick', () => {
    emit('tab1', { type: 'engine_text_delta', text: 'thinking...' })
    emit('tab1', { type: 'engine_tool_start', toolName: 'Bash', toolId: 'toolu_1' })

    const types = sentTypes()
    const deltaIdx = types.indexOf('desktop_text_delta')
    const toolIdx = types.indexOf('desktop_tool_start')

    expect(deltaIdx).toBeGreaterThanOrEqual(0)
    expect(toolIdx).toBeGreaterThanOrEqual(0)
    expect(deltaIdx).toBeLessThan(toolIdx)
  })

  it('sends desktop_text_delta for each unique key that has pending text before message_end', () => {
    // Two concurrent tabs accumulate text, then one fires message_end
    emit('tab1', { type: 'engine_text_delta', text: 'tab1 text' })
    emit('tab2', { type: 'engine_text_delta', text: 'tab2 text' })
    emit('tab1', { type: 'engine_message_end', usage: {} })

    const types = sentTypes()
    // tab1's delta must be sent before its message_end
    const tab1DeltaIdx = mockSend.mock.calls.findIndex(
      (c) => c[0]?.type === 'desktop_text_delta' && c[0]?.tabId === 'tab1',
    )
    const tab1EndIdx = mockSend.mock.calls.findIndex(
      (c) => c[0]?.type === 'desktop_message_end' && c[0]?.tabId === 'tab1',
    )
    expect(tab1DeltaIdx).toBeGreaterThanOrEqual(0)
    expect(tab1EndIdx).toBeGreaterThanOrEqual(0)
    expect(tab1DeltaIdx).toBeLessThan(tab1EndIdx)

    // tab2's delta is still buffered (no message_end yet for tab2)
    // It will be flushed on the next timer tick — not checked here since
    // the timer is mocked. What matters is tab2's text is in the buffer.
    const tab2DeltaSent = mockSend.mock.calls.some(
      (c) => c[0]?.type === 'desktop_text_delta' && c[0]?.tabId === 'tab2',
    )
    // tab2 delta NOT yet sent (no flush trigger for tab2 in this tick)
    expect(tab2DeltaSent).toBe(false)
    void types // suppress unused warning
  })

  it('DROPS pending batched text on engine_stream_reset instead of flushing it', () => {
    // The batched text belongs to the attempt the engine just discarded.
    // Flushing it would deliver stale pre-reset text to iOS AFTER the reset
    // event; the fix drops the batch for the key before forwarding the reset.
    emit('tab1', { type: 'engine_text_delta', text: 'partial from failed attempt' })
    emit('tab1', { type: 'engine_stream_reset' })
    // A later boundary event must not resurrect the dropped batch either.
    emit('tab1', { type: 'engine_message_end', usage: {} })

    const types = sentTypes()
    expect(types).toContain('desktop_stream_reset')
    expect(types).toContain('desktop_message_end')
    expect(types).not.toContain('desktop_text_delta')
  })

  it('forwards engine_stream_reset to iOS as desktop_stream_reset', () => {
    emit('tab1', { type: 'engine_stream_reset' })

    const resetCall = mockSend.mock.calls.find((c) => c[0]?.type === 'desktop_stream_reset')
    expect(resetCall).toBeTruthy()
    expect(resetCall![0].tabId).toBe('tab1')
  })

  it('drops the batch only for the resetting key; other tabs keep their pending text', () => {
    emit('tab1', { type: 'engine_text_delta', text: 'tab1 partial' })
    emit('tab2', { type: 'engine_text_delta', text: 'tab2 healthy stream' })
    emit('tab1', { type: 'engine_stream_reset' })
    // tab2's boundary event flushes tab2's still-valid batch.
    emit('tab2', { type: 'engine_message_end', usage: {} })

    const tab1DeltaSent = mockSend.mock.calls.some(
      (c) => c[0]?.type === 'desktop_text_delta' && c[0]?.tabId === 'tab1',
    )
    const tab2DeltaSent = mockSend.mock.calls.some(
      (c) => c[0]?.type === 'desktop_text_delta' && c[0]?.tabId === 'tab2',
    )
    expect(tab1DeltaSent).toBe(false)
    expect(tab2DeltaSent).toBe(true)
  })

  it('no-ops gracefully when message_end arrives with no buffered text', () => {
    // No preceding text delta for this tab — flushKeyDeltas is a no-op
    expect(() => {
      emit('tab1', { type: 'engine_message_end', usage: {} })
    }).not.toThrow()

    const types = sentTypes()
    expect(types).toContain('desktop_message_end')
    expect(types).not.toContain('desktop_text_delta')
  })
})
