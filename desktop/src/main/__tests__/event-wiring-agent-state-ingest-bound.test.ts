/**
 * event-wiring — engine_agent_state ingest bound (defense in depth)
 *
 * The engine clamps agent-state metadata at the source, but the desktop must
 * not TRUST that: a pre-clamp engine binary once emitted a 30.7 MB roster
 * that was stored verbatim in the main-process mirror and the renderer store,
 * where it OOM-killed the renderer twice. The ingest bound sheds metadata
 * down to the protected identity keys BEFORE the mirror records the roster
 * and before any forward, so no downstream copy can ever hold the unbounded
 * form. These tests fail on the unbounded code (the oversized metadata used
 * to reach both the mirror and the wire intact).
 *
 * Harness mirrors event-wiring-generic-wire-type.test.ts.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: vi.fn() }, ipcMain: { on: vi.fn(), handle: vi.fn() } }))

const { mockSend, mockState, mockPermDenialSet, mockLastStatusMap, capturedHandler } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockState: { remoteTransport: { send: vi.fn() } as any, mainWindow: null },
  mockPermDenialSet: new Set<string>(),
  mockLastStatusMap: new Map<string, string>(),
  capturedHandler: { fn: null as ((key: string, event: any) => void) | null },
}))

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
  lastForwardedTabMeta: new Map(),
}))

vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../settings-store', () => ({ shouldStreamThinkingToRemote: vi.fn(() => true) }))
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), trace: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../shared/clear-divider', () => ({ formatClearDivider: vi.fn(() => '[clear]') }))

import { wireEngineBridgeEvents } from '../event-wiring'
import { getAgentState, clearAllAgentState } from '../agent-state-mirror'

function emit(key: string, event: any): void {
  capturedHandler.fn!(key, event)
}

function sentAgentState() {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter((e) => e?.type === 'desktop_agent_state')
}

describe('wireEngineBridgeEvents — agent_state ingest bound', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler.fn = null
    clearAllAgentState()
    mockState.remoteTransport = { send: mockSend } as any
    mockPermDenialSet.clear()
    mockLastStatusMap.clear()
    wireEngineBridgeEvents()
  })

  it('passes a normal roster through untouched', () => {
    emit('tab1', {
      type: 'engine_agent_state',
      agents: [{ name: 'a', status: 'running', metadata: { displayName: 'A', task: 'small' } }],
    })

    const mirrored = getAgentState('tab1', null)
    expect(mirrored).toHaveLength(1)
    expect((mirrored[0] as any).metadata.task).toBe('small')

    const wire = sentAgentState()
    expect(wire).toHaveLength(1)
    expect(wire[0].metadataOmitted).toBeUndefined()
  })

  it('sheds oversized roster metadata before the mirror and the wire', () => {
    // > 6 MiB of unprotected metadata across two agents — the production
    // shape (a huge per-agent history) at test-friendly scale.
    const huge = 'x'.repeat(4 * 1024 * 1024)
    emit('tab1', {
      type: 'engine_agent_state',
      agents: [
        { name: 'a', status: 'running', metadata: { displayName: 'A', visibility: 'sticky', history: huge } },
        { name: 'b', status: 'done', metadata: { displayName: 'B', invited: true, history: huge } },
      ],
    })

    // The mirror holds the shed form — an iOS resync or self-heal can never
    // re-serialize the unbounded roster again.
    const mirrored = getAgentState('tab1', null) as any[]
    expect(mirrored).toHaveLength(2)
    expect(mirrored[0].metadata.history).toBeUndefined()
    expect(mirrored[0].metadata.displayName).toBe('A')
    expect(mirrored[0].metadata.visibility).toBe('sticky')
    expect(mirrored[1].metadata.invited).toBe(true)

    // The forward carries the shed form, flagged so consumers know detail
    // was lost (existing metadataOmitted degrade semantics).
    const wire = sentAgentState()
    expect(wire).toHaveLength(1)
    expect(wire[0].metadataOmitted).toBe(true)
    expect(wire[0].agents[0].metadata.history).toBeUndefined()
    expect(JSON.stringify(wire[0]).length).toBeLessThan(1024 * 1024)
  })

  it('keeps every agent when shedding — only metadata is lost', () => {
    const huge = 'x'.repeat(7 * 1024 * 1024)
    emit('tab1', {
      type: 'engine_agent_state',
      agents: [
        { name: 'a', status: 'running', metadata: { displayName: 'A', blob: huge } },
        { name: 'b', status: 'running', metadata: { displayName: 'B' } },
      ],
    })

    const mirrored = getAgentState('tab1', null) as any[]
    expect(mirrored.map((a) => a.name)).toEqual(['a', 'b'])
  })
})
