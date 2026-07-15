/**
 * event-wiring — engine_dispatch_activity forwarding & routing
 *
 * Pins the desktop main routing for the live dispatched-agent transcript:
 *
 *  1. iOS forward: engine_dispatch_activity reaches iOS as desktop_dispatch_activity
 *     (via the generic engineToWireType branch) with its dispatch* fields intact.
 *  2. Renderer bridge: it is broadcast to the renderer as a normalized
 *     `dispatch_activity` event (so the agent popup folds it).
 *  3. Routing disambiguation (load-bearing): it is NEVER forwarded as a
 *     main-conversation delta (desktop_text_delta / desktop_tool_start) — those
 *     surfaces are for the parent conversation, and dispatch activity must land
 *     only in the per-dispatch popup cache.
 *
 * Harness mirrors event-wiring-generic-wire-type.test.ts.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const {
  mockSend,
  mockBroadcast,
  mockState,
  mockPermDenialSet,
  mockLastStatusMap,
  capturedHandler,
  mockShouldStream,
} = vi.hoisted(() => {
  const mockSend = vi.fn()
  const mockBroadcast = vi.fn()
  const mockState = {
    remoteTransport: { send: mockSend } as any,
    mainWindow: null,
  }
  const mockPermDenialSet = new Set<string>()
  const mockLastStatusMap = new Map<string, string>()
  const capturedHandler = { fn: null as ((key: string, event: any) => void) | null }
  const mockShouldStream = vi.fn(() => true)
  return { mockSend, mockBroadcast, mockState, mockPermDenialSet, mockLastStatusMap, capturedHandler, mockShouldStream }
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

vi.mock('../broadcast', () => ({ broadcast: mockBroadcast }))
vi.mock('../settings-store', () => ({
  shouldStreamThinkingToRemote: mockShouldStream,
}))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))

import { wireEngineBridgeEvents } from '../event-wiring'

function emit(key: string, event: any): void {
  capturedHandler.fn!(key, event)
}

function sentOfType(wireType: string) {
  return mockSend.mock.calls.filter((c) => c[0]?.type === wireType)
}

/** Normalized events broadcast to the renderer (channel ion:normalized-event). */
function broadcastNormalizedOfType(type: string) {
  return mockBroadcast.mock.calls.filter(
    (c) => c[0] === 'ion:normalized-event' && c[2]?.type === type,
  )
}

const KEY = 'tab1:inst1'

const ACTIVITY_EVENT = {
  type: 'engine_dispatch_activity',
  dispatchAgentId: 'dispatch-dev-lead-123',
  dispatchConversationId: 'child-conv-1',
  dispatchActivityKind: 'tool_start',
  dispatchSeq: 1,
  toolName: 'Read',
  toolId: 'tool-1',
}

describe('wireEngineBridgeEvents — engine_dispatch_activity routing', () => {
  beforeEach(() => {
    mockSend.mockClear()
    mockBroadcast.mockClear()
    capturedHandler.fn = null
    wireEngineBridgeEvents()
    expect(capturedHandler.fn).toBeTruthy()
  })

  it('forwards to iOS as desktop_dispatch_activity with dispatch fields intact', () => {
    emit(KEY, ACTIVITY_EVENT)
    const forwarded = sentOfType('desktop_dispatch_activity')
    expect(forwarded).toHaveLength(1)
    const payload = forwarded[0][0]
    expect(payload.dispatchAgentId).toBe('dispatch-dev-lead-123')
    expect(payload.dispatchConversationId).toBe('child-conv-1')
    expect(payload.dispatchActivityKind).toBe('tool_start')
    expect(payload.toolId).toBe('tool-1')
    // tabId/instanceId ride-along from the wire key split.
    expect(payload.tabId).toBe('tab1')
    expect(payload.instanceId).toBe('inst1')
  })

  it('bridges to the renderer as a normalized dispatch_activity event', () => {
    emit(KEY, ACTIVITY_EVENT)
    const bridged = broadcastNormalizedOfType('dispatch_activity')
    expect(bridged).toHaveLength(1)
    expect(bridged[0][1]).toBe('tab1') // tabId
    expect(bridged[0][2].dispatchConversationId).toBe('child-conv-1')
    expect(bridged[0][2].dispatchSeq).toBe(1)
  })

  it('does NOT route dispatch activity to the main-conversation delta surfaces', () => {
    emit(KEY, ACTIVITY_EVENT)
    // The popup transcript must never leak into the parent conversation stream.
    expect(sentOfType('desktop_text_delta')).toHaveLength(0)
    expect(sentOfType('desktop_tool_start')).toHaveLength(0)
    expect(sentOfType('desktop_tool_call')).toHaveLength(0)
    expect(broadcastNormalizedOfType('text_chunk')).toHaveLength(0)
    expect(broadcastNormalizedOfType('tool_call')).toHaveLength(0)
  })
})
