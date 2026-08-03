/**
 * event-wiring-remote — engine-bridge-covered event suppression
 *
 * Regression test for Fix 3 of the post-#256 iOS streaming regression.
 *
 * Post-#256 every conversation is engine-backed. The engine-bridge generic
 * forwarder (wireEngineBridgeEvents in event-wiring.ts) sends desktop_text_delta,
 * desktop_tool_start, and desktop_tool_end as CRITICAL wire events. The session-
 * plane normalizedToRemote() path ALSO produces desktop_text_chunk, desktop_tool_call,
 * and desktop_tool_result for the same events — non-critical duplicates that flood
 * the transport queue at 50-200/sec without contributing any information (iOS
 * ignores them for loaded conversations via the conversationLoaded guard).
 *
 * Fix: wireRemoteSessionPlaneForwarding now skips the normalizedToRemote send
 * for text_chunk, tool_call, tool_call_update, and tool_result, while still
 * forwarding session-plane-only events that have no engine-bridge equivalent
 * (task_complete, compacting, error, permission_request).
 *
 * These tests go RED if the suppression is removed and the redundant non-critical
 * sends are reintroduced, or if task_complete stops being forwarded.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const { mockSend, mockState, sessionPlaneEmitter } = vi.hoisted(() => {
  const mockSend = vi.fn()
  const mockState = { remoteTransport: { send: mockSend } as any, mainWindow: null }
  const sessionPlaneEmitter = new (require('events').EventEmitter)()
  return { mockSend, mockState, sessionPlaneEmitter }
})

vi.mock('../state', () => ({
  state: mockState,
  sessionPlane: sessionPlaneEmitter,
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map<string, string>(),
}))

// Use the real normalizedToRemote so desktop_text_chunk / desktop_task_complete
// are actually produced when we emit the corresponding events. The test verifies
// that desktop_text_chunk is suppressed and desktop_task_complete is forwarded.
vi.mock('../../shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { wireRemoteSessionPlaneForwarding } from '../event-wiring-remote'

function sentOfType(type: string) {
  return mockSend.mock.calls.filter((c) => (c[0] as any)?.type === type)
}

describe('wireRemoteSessionPlaneForwarding — suppress engine-bridge-covered event types', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(sessionPlaneEmitter as EventEmitter).removeAllListeners()
    mockState.remoteTransport = { send: mockSend } as any
    wireRemoteSessionPlaneForwarding()
  })

  it('does NOT send desktop_text_chunk for text_chunk (engine-bridge path owns it)', () => {
    sessionPlaneEmitter.emit('event', 'tab1', { type: 'text_chunk', text: 'hello' })
    expect(sentOfType('desktop_text_chunk')).toHaveLength(0)
  })

  it('does NOT send desktop_tool_call for tool_call (desktop_tool_start owns it)', () => {
    sessionPlaneEmitter.emit('event', 'tab1', {
      type: 'tool_call', toolName: 'Bash', toolId: 'toolu_1', index: 0,
    })
    expect(sentOfType('desktop_tool_call')).toHaveLength(0)
  })

  it('does NOT send desktop_tool_call for tool_call_update', () => {
    sessionPlaneEmitter.emit('event', 'tab1', {
      type: 'tool_call_update', toolId: 'toolu_1', partialInput: '{"cmd":"ls"}',
    })
    // normalizedToRemote returns null for tool_call_update (no mapping), so
    // nothing would be sent regardless — but the guard must also not fire.
    expect(sentOfType('desktop_tool_call')).toHaveLength(0)
    expect(sentOfType('desktop_tool_result')).toHaveLength(0)
  })

  it('does NOT send desktop_tool_result for tool_result (desktop_tool_end owns it)', () => {
    sessionPlaneEmitter.emit('event', 'tab1', {
      type: 'tool_result', toolId: 'toolu_1', content: 'ok', isError: false,
    })
    expect(sentOfType('desktop_tool_result')).toHaveLength(0)
  })

  it('STILL sends desktop_task_complete for task_complete (no engine-bridge equivalent)', () => {
    sessionPlaneEmitter.emit('event', 'tab1', {
      type: 'task_complete', result: 'done', costUsd: 0.01, reason: 'max_turns',
    })
    const sent = sentOfType('desktop_task_complete')
    expect(sent).toHaveLength(1)
    expect(sent[0][0]).toMatchObject({ type: 'desktop_task_complete', tabId: 'tab1', reason: 'max_turns' })
  })

  it('task_complete is NOT in the isCoveredByEngineBridge suppression set — send fires exactly once', () => {
    // This test goes RED if task_complete is added to the isCoveredByEngineBridge
    // guard in wireRemoteSessionPlaneForwarding. Adding it there would suppress
    // the only forwarding path for task_complete, silently dropping it on iOS.
    sessionPlaneEmitter.emit('event', 'tab2', {
      type: 'task_complete', result: 'success', costUsd: 0.05,
    })
    // Exactly one send — through the normalizedToRemote path, not suppressed.
    expect(mockSend.mock.calls).toHaveLength(1)
    expect(mockSend.mock.calls[0][0]).toMatchObject({ type: 'desktop_task_complete', tabId: 'tab2' })
  })
})
