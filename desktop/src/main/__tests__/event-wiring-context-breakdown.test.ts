/**
 * event-wiring — engine_context_breakdown renderer forwarding
 *
 * The engine emits engine_context_breakdown with a populated modelBreakdown
 * array (per-model cost rows for the dispatch tree). event-wiring rebuilds the
 * renderer-bound NormalizedEvent field-by-field before broadcasting. A dropped
 * field in that reconstruction means the renderer receives modelBreakdown=undefined
 * and the StatusDrawer guard (modelBreakdown && length>0) hides the list.
 *
 * These tests pin that every field of the ContextBreakdownPayload survives the
 * main-process reconstruction — modelBreakdown in particular. The modelBreakdown
 * assertion fails on the pre-fix code (the reconstruction omitted the field).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const {
  mockBroadcast,
  mockSend,
  mockState,
  mockPermDenialSet,
  mockLastStatusMap,
  capturedHandler,
} = vi.hoisted(() => {
  const mockBroadcast = vi.fn()
  const mockSend = vi.fn()
  const mockState = {
    remoteTransport: { send: mockSend } as any,
    mainWindow: null,
  }
  const mockPermDenialSet = new Set<string>()
  const mockLastStatusMap = new Map<string, string>()
  const capturedHandler = { fn: null as ((key: string, event: any) => void) | null }
  return { mockBroadcast, mockSend, mockState, mockPermDenialSet, mockLastStatusMap, capturedHandler }
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
vi.mock('../settings-store', () => ({ currentBackend: 'test' }))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))

import { wireEngineBridgeEvents } from '../event-wiring'

function emit(key: string, event: any): void {
  capturedHandler.fn!(key, event)
}

/** Extract the NormalizedEvent broadcast to the renderer on the normalized stream. */
function normalizedBreakdownEvents() {
  return mockBroadcast.mock.calls
    .filter((c) => c[0] === 'ion:normalized-event' && c[2]?.type === 'context_breakdown')
    .map((c) => c[2])
}

const MODEL_BREAKDOWN = [
  { model: 'claude-opus-4', conversations: 3, inputTokens: 12000, outputTokens: 4500, costUsd: 1.23 },
  { model: 'claude-sonnet-4', conversations: 7, inputTokens: 88000, outputTokens: 9200, costUsd: 0.41 },
]

function breakdownEvent(overrides: Record<string, any> = {}): any {
  return {
    type: 'engine_context_breakdown',
    contextBreakdown: {
      categories: [{ name: 'system', kind: 'system', tokens: 1000, tier: 'exact' }],
      contextWindow: 200000,
      totalTokens: 50000,
      apiReportedTotal: 51000,
      unaccounted: 1000,
      cacheReadTokens: 3000,
      cacheCreationTokens: 500,
      model: 'claude-opus-4',
      aggregateCostUsd: 1.64,
      modelBreakdown: MODEL_BREAKDOWN,
      ...overrides,
    },
  }
}

describe('wireEngineBridgeEvents — engine_context_breakdown renderer forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler.fn = null
    mockState.remoteTransport = { send: mockSend } as any
    mockPermDenialSet.clear()
    mockLastStatusMap.clear()
    wireEngineBridgeEvents()
  })

  it('forwards modelBreakdown array intact to the renderer (regression: dropped field)', () => {
    emit('tab1:inst1', breakdownEvent())

    const events = normalizedBreakdownEvents()
    expect(events).toHaveLength(1)
    // The dropped-field bug: the reconstruction copied aggregateCostUsd but not
    // modelBreakdown, so the renderer saw undefined and hid the per-model list.
    expect(events[0].modelBreakdown).toEqual(MODEL_BREAKDOWN)
    expect(events[0].modelBreakdown).toHaveLength(2)
  })

  it('forwards every ContextBreakdownPayload field, not just modelBreakdown', () => {
    emit('tab1:inst1', breakdownEvent())

    const [ev] = normalizedBreakdownEvents()
    expect(ev.categories).toHaveLength(1)
    expect(ev.contextWindow).toBe(200000)
    expect(ev.totalTokens).toBe(50000)
    expect(ev.apiReportedTotal).toBe(51000)
    expect(ev.unaccounted).toBe(1000)
    expect(ev.cacheReadTokens).toBe(3000)
    expect(ev.cacheCreationTokens).toBe(500)
    expect(ev.model).toBe('claude-opus-4')
    expect(ev.aggregateCostUsd).toBe(1.64)
    expect(ev.modelBreakdown).toEqual(MODEL_BREAKDOWN)
  })

  it('preserves an empty modelBreakdown array (runloop-emitted breakdowns)', () => {
    emit('tab1:inst1', breakdownEvent({ modelBreakdown: [] }))

    const [ev] = normalizedBreakdownEvents()
    expect(ev.modelBreakdown).toEqual([])
  })

  it('forwards the whole contextBreakdown object to iOS with modelBreakdown intact', () => {
    emit('tab1:inst1', breakdownEvent())

    // engine_context_breakdown reaches iOS via two paths today: the explicit
    // desktop_context_breakdown block and the generic engineToWireType
    // forwarder (both map to desktop_context_breakdown). The iOS spread passes
    // the whole contextBreakdown object, so modelBreakdown was never dropped on
    // the iOS side — only on the renderer reconstruction. Pin that EVERY iOS
    // send carries the array intact, without over-constraining the send count.
    const iosCalls = mockSend.mock.calls.filter((c) => c[0]?.type === 'desktop_context_breakdown')
    expect(iosCalls.length).toBeGreaterThanOrEqual(1)
    for (const call of iosCalls) {
      expect(call[0].contextBreakdown.modelBreakdown).toEqual(MODEL_BREAKDOWN)
    }
  })
})
