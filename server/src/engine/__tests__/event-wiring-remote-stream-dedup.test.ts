/**
 * event-wiring-remote — the session-plane forwarder sends no transcript rows
 *
 * A thin client receives every conversation row on its transcript stream,
 * published from the store. The session-plane forwarder must never send a
 * row of its own (`desktop_message_added` / `desktop_message_updated`): that
 * second copy is what used to duplicate rows on the phone until a reload.
 * It still sends the two notices that are not rows: task completion and
 * permission requests.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const { mockSend, mockState, sessionPlaneEmitter } = vi.hoisted(() => {
  const mockSend = vi.fn()
  const mockState = { mainWindow: null }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sessionPlaneEmitter = new (require('events').EventEmitter)()
  return { mockSend, mockState, sessionPlaneEmitter }
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
  sessionPlane: sessionPlaneEmitter,
  activeAssistantMessages: new Map(),
  lastMessagePreview: new Map<string, string>(),
} }))

// normalizedToRemote returns null so the top-of-listener send is suppressed in
// this test — we are exercising ONLY the switch branches' message envelopes.
vi.mock('@ion/shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))

import { wireRemoteSessionPlaneForwarding } from '../event-wiring-remote'

function sentOfType(type: string) {
  return mockSend.mock.calls.filter((c) => (c[0] as any)?.type === type)
}

describe('wireRemoteSessionPlaneForwarding — no transcript rows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(sessionPlaneEmitter as EventEmitter).removeAllListeners()
    mockClientsPresent.mockReturnValue(true)
    wireRemoteSessionPlaneForwarding()
  })

  it('does NOT send desktop_message_added for a text_chunk', () => {
    sessionPlaneEmitter.emit('event', 'tab1', { type: 'text_chunk', text: 'hello' })
    expect(sentOfType('desktop_message_added')).toHaveLength(0)
    expect(sentOfType('desktop_message_updated')).toHaveLength(0)
  })

  it('does NOT send a second envelope when a text_chunk extends an in-flight assistant message', () => {
    sessionPlaneEmitter.emit('event', 'tab1', { type: 'text_chunk', text: 'hello' })
    sessionPlaneEmitter.emit('event', 'tab1', { type: 'text_chunk', text: ' world' })
    expect(sentOfType('desktop_message_added')).toHaveLength(0)
    expect(sentOfType('desktop_message_updated')).toHaveLength(0)
  })

  it('does NOT send desktop_message_added(tool) for a tool_call', () => {
    sessionPlaneEmitter.emit('event', 'tab1', { type: 'tool_call', toolName: 'Bash', toolId: 'toolu_1', index: 0 })
    expect(sentOfType('desktop_message_added')).toHaveLength(0)
  })

  it('does NOT send desktop_message_updated for a tool_call_update', () => {
    sessionPlaneEmitter.emit('event', 'tab1', { type: 'tool_call_update', toolId: 'toolu_1', partialInput: '{"a":1}' })
    expect(sentOfType('desktop_message_updated')).toHaveLength(0)
  })

  it('does NOT send desktop_message_updated for a tool_result', () => {
    sessionPlaneEmitter.emit('event', 'tab1', { type: 'tool_result', toolId: 'toolu_1', content: 'ok', isError: false })
    expect(sentOfType('desktop_message_updated')).toHaveLength(0)
  })

  it('sends nothing for a compaction: its row is on the transcript stream', () => {
    sessionPlaneEmitter.emit('event', 'tab1', {
      type: 'compacting',
      active: false,
      messagesBefore: 40,
      messagesAfter: 5,
      summary: 'did stuff',
      strategy: 'summarize',
    })
    expect(mockSend).not.toHaveBeenCalled()
  })
})
