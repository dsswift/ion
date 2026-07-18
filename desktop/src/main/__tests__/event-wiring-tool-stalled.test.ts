/**
 * event-wiring — engine_tool_stalled wire projection
 *
 * Regression test for the iOS full-resync-per-stalled-tick bug: the generic
 * engine-event forwarder shipped `engine_tool_stalled` via blind spread
 * (`{...event, tabId, instanceId, type: 'desktop_tool_stalled'}`). The raw
 * engine event carries the field `toolElapsed`, but the wire contract
 * (remote/protocol.ts `desktop_tool_stalled`) declares `elapsed: number`, and
 * iOS's decoder requires `elapsed` — the decode threw "Key 'elapsed' not
 * found" and triggered a full resync on EVERY stalled-tool tick (log-confirmed
 * 8× in one session).
 *
 * The fix projects the event explicitly at the forward seam with exactly the
 * protocol's declared fields (toolId / toolName carry over unchanged;
 * `elapsed` maps from `toolElapsed`), mirroring the renderer-side mapping in
 * engine-control-plane-stream.ts (`elapsed: event.toolElapsed`).
 *
 * Harness mirrors event-wiring-generic-wire-type.test.ts (same vi.hoisted
 * mock block, same captured `engineBridge.'event'` handler, same
 * `sentOfType` helper).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const {
  mockSend,
  mockState,
  mockPermDenialSet,
  mockLastStatusMap,
  mockLastMetaMap,
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
  const mockLastMetaMap = new Map<string, number>()
  const capturedHandler = { fn: null as ((key: string, event: any) => void) | null }
  const mockShouldStream = vi.fn(() => true)
  return {
    mockSend,
    mockState,
    mockPermDenialSet,
    mockLastStatusMap,
    mockLastMetaMap,
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
  lastForwardedTabMeta: mockLastMetaMap,
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

// Compound key (`tabId:instanceId`) — the forwarder splits it for the
// tabId/instanceId ride-along.
const KEY = 'tab1:inst1'

describe('wireEngineBridgeEvents — engine_tool_stalled projection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler.fn = null
    mockState.remoteTransport = { send: mockSend } as any
    mockPermDenialSet.clear()
    mockLastStatusMap.clear()
    mockLastMetaMap.clear()
    mockShouldStream.mockReturnValue(true)
    wireEngineBridgeEvents()
  })

  it('forwards engine_tool_stalled as desktop_tool_stalled with elapsed mapped from toolElapsed', () => {
    emit(KEY, {
      type: 'engine_tool_stalled',
      toolId: 'tool-abc',
      toolName: 'Bash',
      toolElapsed: 42,
    })

    const sent = sentOfType('desktop_tool_stalled')
    expect(sent).toHaveLength(1)
    // The contract field iOS requires. Pre-fix the blind spread shipped
    // `toolElapsed` and omitted `elapsed`, so the iOS decode threw
    // "Key 'elapsed' not found" and forced a full resync per tick.
    expect(sent[0][0].elapsed).toBe(42)
  })

  it('the forwarded frame carries every field protocol.ts declares for desktop_tool_stalled', () => {
    emit(KEY, {
      type: 'engine_tool_stalled',
      toolId: 'tool-abc',
      toolName: 'Bash',
      toolElapsed: 42,
    })

    const sent = sentOfType('desktop_tool_stalled')
    expect(sent).toHaveLength(1)
    expect(sent[0][0]).toEqual({
      type: 'desktop_tool_stalled',
      tabId: 'tab1',
      instanceId: 'inst1',
      toolId: 'tool-abc',
      toolName: 'Bash',
      elapsed: 42,
    })
  })

  it('never forwards the raw engine field name or engine_ wire type', () => {
    emit(KEY, {
      type: 'engine_tool_stalled',
      toolId: 'tool-abc',
      toolName: 'Bash',
      toolElapsed: 42,
    })

    expect(sentOfType('engine_tool_stalled')).toHaveLength(0)
    const sent = sentOfType('desktop_tool_stalled')
    expect(sent).toHaveLength(1)
    // Explicit projection replaces the blind spread — the raw engine key
    // must not ride along on the wire frame.
    expect('toolElapsed' in sent[0][0]).toBe(false)
  })
})
