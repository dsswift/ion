/**
 * event-wiring — engine_dispatch_activity routing
 *
 * Pins the routing for a dispatched agent's live activity:
 *
 *  1. Renderer bridge: it is broadcast to Studio as a normalized
 *     `dispatch_activity` event (so the agent panel folds it).
 *  2. It is never sent to a mobile client: a thin client receives the
 *     dispatch's rows on the dispatch transcript stream instead.
 *  3. It never reaches the parent conversation's surfaces.
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
    mainWindow: null,
  }
  const mockPermDenialSet = new Set<string>()
  const mockLastStatusMap = new Map<string, string>()
  const capturedHandler = { fn: null as ((key: string, event: any) => void) | null }
  const mockShouldStream = vi.fn(() => true)
  return { mockSend, mockBroadcast, mockState, mockPermDenialSet, mockLastStatusMap, capturedHandler, mockShouldStream }
})

// The `desktop_*` device transport is gone; a RemoteEvent now leaves the
// server through `sendRemoteEvent`, which fans it to thin Studio-wire
// clients. Capture there, and drive the "is anyone listening" gate with
// `remoteClientsPresent`.
const { mockClientsPresent } = vi.hoisted(() => ({ mockClientsPresent: vi.fn(() => true) }))

vi.mock('@ion/server/thin-view/remote-out', () => ({
  sendRemoteEvent: mockSend,
  remoteClientsPresent: mockClientsPresent,
  syncRemoteAttention: vi.fn(),
  thinConnections: vi.fn(() => []),
  sendThinEventTo: vi.fn(() => true),
}))

vi.mock('@ion/server/state', async (importOriginal) => ({ ...(await importOriginal()), ...{
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

vi.mock('@ion/server/broadcast', () => ({ broadcast: mockBroadcast }))
vi.mock('@ion/server/persistence/settings-store', async (importOriginal) => ({ ...(await importOriginal()), ...{
  shouldStreamThinkingToRemote: mockShouldStream,
} }))
vi.mock('@ion/server/logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() }))
vi.mock('@ion/shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))

import { wireEngineBridgeEvents } from '@ion/server/engine/event-wiring'

function emit(key: string, event: any): void {
  capturedHandler.fn!(key, event)
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

  it('sends a mobile client nothing: the dispatch transcript stream carries its rows', () => {
    emit(KEY, ACTIVITY_EVENT)
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('bridges to the renderer as a normalized dispatch_activity event', () => {
    emit(KEY, ACTIVITY_EVENT)
    const bridged = broadcastNormalizedOfType('dispatch_activity')
    expect(bridged).toHaveLength(1)
    expect(bridged[0][1]).toBe('tab1') // tabId
    expect(bridged[0][2].dispatchConversationId).toBe('child-conv-1')
    expect(bridged[0][2].dispatchSeq).toBe(1)
  })

  it('bridges a stream reset boundary to the renderer', () => {
    emit(KEY, {
      ...ACTIVITY_EVENT,
      dispatchActivityKind: 'stream_reset',
      dispatchSeq: 5,
      dispatchResetAfterSeq: 2,
      toolName: undefined,
      toolId: undefined,
    })
    const renderer = broadcastNormalizedOfType('dispatch_activity')[0][2]
    expect(renderer.dispatchResetAfterSeq).toBe(2)
  })

  it('does NOT route dispatch activity to the main-conversation delta surfaces', () => {
    emit(KEY, ACTIVITY_EVENT)
    // The popup transcript must never leak into the parent conversation stream.
    expect(broadcastNormalizedOfType('text_chunk')).toHaveLength(0)
    expect(broadcastNormalizedOfType('tool_call')).toHaveLength(0)
  })
})
