/**
 * engine-control-plane-events — dispatch normalizer dispatchId regression
 *
 * Root cause: engine-control-plane-events.ts normalizes engine_dispatch_start
 * and engine_dispatch_end WITHOUT forwarding dispatchId (or
 * dispatchConversationId on _end). buildDispatchStartEntry therefore records
 * dispatchId:'' for every entry, and the snapshot ships '' to iOS. The child
 * accessor join (dispatchParentId == parentDispatchId) collapses because the
 * parent's dispatchId is ''.
 *
 * Fix: add `dispatchId: event.dispatchId || ''` to the dispatch_start arm, and
 * `dispatchId: event.dispatchId || ''` + `dispatchConversationId:
 * event.dispatchConversationId || ''` to the dispatch_end arm.
 *
 * Regression assertions:
 *   1. Normalizer pass-through: engine_dispatch_start with a real dispatchId
 *      produces a dispatch_start NormalizedEvent carrying that same dispatchId
 *      (not '').
 *   2. Normalizer pass-through: engine_dispatch_end with a real dispatchId
 *      produces a dispatch_end NormalizedEvent carrying that dispatchId AND
 *      dispatchConversationId.
 *   3. End-to-end through buildDispatchStartEntry: the DispatchTelemetryEntry
 *      built from a normalizer-produced dispatch_start carries the real
 *      dispatchId so tier-3 child entries can join to it via
 *      dispatchParentId == dispatchId.
 *
 * REVERT CHECK: reverting the normalizer to drop dispatchId turns all three
 * tests red. The tests are meaningless if the normalizer passes '' through —
 * they assert the non-empty value explicitly.
 */

import { vi, describe, it, expect } from 'vitest'

vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../session-meta', () => ({
  conversationExists: vi.fn(() => true),
}))

import { handleEngineEvent } from '../engine-control-plane-events'
import type { TabEntry, EventEmitterContext } from '../engine-control-plane-events'
import { buildDispatchStartEntry } from '../../renderer/stores/slices/engine-event-slice-helpers'
import type { NormalizedEvent } from '../../shared/types-events'

function makeTab(overrides: Partial<TabEntry> = {}): TabEntry {
  return {
    tabId: 'tab-001',
    status: 'running',
    activeRequestId: null,
    conversationId: null,
    engineSessionStarted: true,
    lastActivityAt: Date.now(),
    promptCount: 0,
    promptCountSinceCheckpoint: 0,
    clearedSinceLastPrompt: false,
    resumedSavedConversation: false,
    permissionMode: 'auto',
    approvedTools: [],
    startedAt: Date.now() - 1000,
    toolCallCount: 0,
    sawPermissionRequest: false,
    lastSurfacedProposalSig: null,
    ...overrides,
  }
}

// Collect only 'event' emissions (the normalized-event channel).
function makeCtx(): { ctx: EventEmitterContext; events: NormalizedEvent[] } {
  const events: NormalizedEvent[] = []
  const ctx: EventEmitterContext = {
    bridge: {
      updateSessionConversationId: vi.fn(),
      startSession: vi.fn().mockResolvedValue({ ok: true }),
      getSessionConfig: vi.fn().mockReturnValue(undefined),
    } as any,
    emit: (name: string, _tabId: unknown, event: unknown) => {
      if (name === 'event') events.push(event as NormalizedEvent)
    },
    setStatus: vi.fn(),
    checkDrain: vi.fn(),
  }
  return { ctx, events }
}

// ─── Test 1: dispatch_start normalizer carries dispatchId ────────────────────

describe('engine_dispatch_start normalizer — dispatchId pass-through', () => {
  it('produces a dispatch_start NormalizedEvent with the real dispatchId (not empty string)', () => {
    // REVERT CHECK: removing `dispatchId: event.dispatchId || ''` from the
    // engine_dispatch_start arm makes emitted[0].dispatchId === '' and this
    // test fails with "expected '' to be 'disp-tier2-abc'".
    const { ctx, events } = makeCtx()
    const tab = makeTab()

    handleEngineEvent(ctx, 'tab-001', tab, {
      type: 'engine_dispatch_start',
      dispatchId: 'disp-tier2-abc',
      dispatchAgent: 'engine-dev',
      dispatchTask: 'implement feature #170',
      dispatchModel: 'claude-opus-4-8',
      dispatchSessionId: 'sess-abc',
      dispatchDepth: 1,
      dispatchParentId: 'root-dispatch',
    } as any)

    expect(events).toHaveLength(1)
    const ev = events[0] as any
    expect(ev.type).toBe('dispatch_start')
    // The failing field: before the fix this is '' because the normalizer dropped it.
    expect(ev.dispatchId).toBe('disp-tier2-abc')
    // Confirm the other fields still come through.
    expect(ev.dispatchAgent).toBe('engine-dev')
    expect(ev.dispatchDepth).toBe(1)
    expect(ev.dispatchParentId).toBe('root-dispatch')
  })

  it('defaults dispatchId to empty string when the engine event omits it', () => {
    const { ctx, events } = makeCtx()
    const tab = makeTab()

    handleEngineEvent(ctx, 'tab-001', tab, {
      type: 'engine_dispatch_start',
      dispatchAgent: 'engine-dev',
      dispatchTask: 'task',
      dispatchModel: 'claude-opus-4-8',
      dispatchSessionId: 'sess-xyz',
      dispatchDepth: 0,
      dispatchParentId: '',
    } as any)

    expect(events).toHaveLength(1)
    const ev = events[0] as any
    expect(ev.dispatchId).toBe('')
  })
})

// ─── Test 2: dispatch_end normalizer carries dispatchId + dispatchConversationId

describe('engine_dispatch_end normalizer — dispatchId and dispatchConversationId pass-through', () => {
  it('produces a dispatch_end NormalizedEvent with the real dispatchId', () => {
    // REVERT CHECK: removing `dispatchId` from the engine_dispatch_end arm
    // makes ev.dispatchId undefined/'', failing this assertion.
    const { ctx, events } = makeCtx()
    const tab = makeTab()

    handleEngineEvent(ctx, 'tab-001', tab, {
      type: 'engine_dispatch_end',
      dispatchId: 'disp-tier2-abc',
      dispatchAgent: 'engine-dev',
      dispatchExitCode: 0,
      dispatchElapsed: 2.3,
      dispatchCost: 0.0012,
      dispatchDepth: 1,
      dispatchParentId: 'root-dispatch',
      dispatchConversationId: 'conv-child-xyz',
    } as any)

    expect(events).toHaveLength(1)
    const ev = events[0] as any
    expect(ev.type).toBe('dispatch_end')
    expect(ev.dispatchId).toBe('disp-tier2-abc')
  })

  it('produces a dispatch_end NormalizedEvent with dispatchConversationId', () => {
    // REVERT CHECK: removing `dispatchConversationId` from the
    // engine_dispatch_end arm makes ev.dispatchConversationId undefined/'',
    // failing this assertion. applyDispatchEnd reads this field to set the
    // DispatchTelemetryEntry.conversationId used by iOS child-dispatch lookup.
    const { ctx, events } = makeCtx()
    const tab = makeTab()

    handleEngineEvent(ctx, 'tab-001', tab, {
      type: 'engine_dispatch_end',
      dispatchId: 'disp-tier2-abc',
      dispatchAgent: 'engine-dev',
      dispatchExitCode: 0,
      dispatchElapsed: 2.3,
      dispatchCost: 0.0012,
      dispatchDepth: 1,
      dispatchParentId: 'root-dispatch',
      dispatchConversationId: 'conv-child-xyz',
    } as any)

    expect(events).toHaveLength(1)
    const ev = events[0] as any
    expect(ev.dispatchConversationId).toBe('conv-child-xyz')
  })

  it('defaults both fields to empty string when omitted from the engine event', () => {
    const { ctx, events } = makeCtx()
    const tab = makeTab()

    handleEngineEvent(ctx, 'tab-001', tab, {
      type: 'engine_dispatch_end',
      dispatchAgent: 'engine-dev',
      dispatchExitCode: 1,
      dispatchElapsed: 0.1,
      dispatchCost: 0,
      dispatchDepth: 0,
      dispatchParentId: '',
    } as any)

    expect(events).toHaveLength(1)
    const ev = events[0] as any
    expect(ev.dispatchId).toBe('')
    expect(ev.dispatchConversationId).toBe('')
  })
})

// ─── Test 3: end-to-end through buildDispatchStartEntry ─────────────────────

describe('dispatch normalizer → buildDispatchStartEntry end-to-end', () => {
  it('DispatchTelemetryEntry carries the real dispatchId so tier-3 joins work', () => {
    // This is the full chain that was broken:
    //   engine_dispatch_start (with real dispatchId)
    //   → normalizer strips dispatchId → dispatch_start NormalizedEvent has dispatchId:''
    //   → buildDispatchStartEntry → DispatchTelemetryEntry.dispatchId = ''
    //   → snapshot ships '' to iOS
    //   → iOS childrenOf(parentDispatchId) join collapses because parent dispatchId is ''
    //
    // REVERT CHECK: reverting the normalizer fix produces entry.dispatchId===''
    // and this test fails — confirming the end-to-end path is broken.
    const { ctx, events } = makeCtx()
    const tab = makeTab()

    handleEngineEvent(ctx, 'tab-001', tab, {
      type: 'engine_dispatch_start',
      dispatchId: 'tier2-dispatch-id',
      dispatchAgent: 'desktop-dev',
      dispatchTask: 'implement sidebar',
      dispatchModel: 'claude-sonnet-4',
      dispatchSessionId: 'sess-tier2',
      dispatchDepth: 2,
      dispatchParentId: 'tier1-dispatch-id',
    } as any)

    expect(events).toHaveLength(1)
    const normalized = events[0]
    expect(normalized.type).toBe('dispatch_start')

    // Feed the normalized event through buildDispatchStartEntry exactly as
    // event-slice.ts does (line: instPatch.dispatchTelemetry = [..., buildDispatchStartEntry(event)]).
    const entry = buildDispatchStartEntry(normalized as NormalizedEvent & { type: 'dispatch_start' })

    // The entry's dispatchId must be the real value, not ''.
    // A tier-3 child entry whose dispatchParentId === 'tier2-dispatch-id' will
    // only join correctly if this is non-empty and correct.
    expect(entry.dispatchId).toBe('tier2-dispatch-id')
    expect(entry.dispatchParentId).toBe('tier1-dispatch-id')
    expect(entry.dispatchDepth).toBe(2)
    expect(entry.dispatchAgent).toBe('desktop-dev')
  })
})
