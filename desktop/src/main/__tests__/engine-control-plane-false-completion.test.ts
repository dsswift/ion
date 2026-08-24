/**
 * False-completion regression — the status handler must not synthesize a
 * `task_complete` from a snapshot that predates the in-flight prompt.
 *
 * THE LIVE BUG (conversation 1783703005832-8f9ea7705fa6)
 *
 * Sending a prompt marked the conversation Done ~6 ms later, with the
 * completion sound, ~7 s before the run actually started:
 *
 *   11:50:50.970  idle -> connecting          (prompt submitted)
 *   11:50:50.971  reconcile_state requested   (start_session handshake)
 *   11:50:50.971  connecting -> running       (ensureSession succeeded)
 *   11:50:50.976  task_complete SYNTHESIZED   <-- false
 *   11:50:57.924  idle -> running             (the real run)
 *
 * The reconcile answer was built before SendPrompt assigned run identity, so
 * the engine honestly reported idle. The handler read it as a completion.
 *
 * The 'connecting' skip that already existed does not fire, because
 * ensureSession moves the tab to 'running' before the answer arrives — which is
 * exactly why these tests drive the handler with `status: 'running'`.
 *
 * These assert on the HANDLER, not the pure decision helper: the defect was a
 * synthesized `task_complete` reaching consumers, so the test has to pin that
 * no such event is emitted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../session-meta', () => ({
  conversationExists: vi.fn(() => true),
}))

vi.mock('../tool-gate-responder', () => ({
  toolGateSessionConfig: vi.fn(() => undefined),
}))

import { handleEngineEvent } from '../engine-control-plane-events'
import type { TabEntry, EventEmitterContext } from '../engine-control-plane-events'
import type { EngineEvent } from '../../shared/types'

function makeTab(overrides: Partial<TabEntry> = {}): TabEntry {
  return {
    tabId: 'tab-001',
    status: 'running',
    activeRequestId: null,
    conversationId: 'conv-1',
    engineSessionStarted: true,
    lastActivityAt: Date.now(),
    promptCount: 1,
    promptCountSinceCheckpoint: 1,
    clearedSinceLastPrompt: false,
    resumedSavedConversation: false,
    permissionMode: 'auto',
    approvedTools: [],
    startedAt: Date.now() - 10,
    toolCallCount: 0,
    sawPermissionRequest: false,
    lastSurfacedProposalSig: null,
    dispatchRunEpoch: null,
    lastObservedRunEpoch: null,
    dispatchAcknowledged: false,
    ...overrides,
  }
}

function idleStatus(runEpoch?: number): EngineEvent {
  return {
    type: 'engine_status',
    fields: {
      state: 'idle',
      sessionId: 'conv-1',
      label: 'tab-001',
      runCostUsd: 0,
      ...(runEpoch === undefined ? {} : { runEpoch }),
    },
  } as EngineEvent
}

function runningStatus(runEpoch?: number): EngineEvent {
  return {
    type: 'engine_status',
    fields: {
      state: 'running',
      sessionId: 'conv-1',
      label: 'tab-001',
      ...(runEpoch === undefined ? {} : { runEpoch }),
    },
  } as EngineEvent
}

describe('handleStatusEvent — idle ordering against an in-flight prompt', () => {
  let ctx: EventEmitterContext
  let emitted: Array<[string, ...unknown[]]>

  function taskCompletes(): unknown[] {
    return emitted.filter(
      ([name, , payload]) =>
        name === 'event' && (payload as { type?: string })?.type === 'task_complete',
    )
  }

  beforeEach(() => {
    emitted = []
    ctx = {
      bridge: {
        updateSessionConversationId: vi.fn(),
        startSession: vi.fn().mockResolvedValue({ ok: true }),
        getSessionConfig: vi.fn().mockReturnValue(undefined),
      } as any,
      emit: (eventName: string, ...args: unknown[]) => { emitted.push([eventName, ...args]) },
      setStatus: vi.fn(),
      checkDrain: vi.fn(),
    }
  })

  it('does NOT synthesize task_complete for a reconcile idle at the dispatch epoch', () => {
    // The exact live sequence: dispatched at epoch 7, tab already flipped to
    // 'running' by ensureSession, reconcile answer still reports epoch 7.
    const tab = makeTab({ activeRequestId: 'req-1', dispatchRunEpoch: 7, status: 'running' })

    handleEngineEvent(ctx, 'tab-001', tab, idleStatus(7))

    expect(taskCompletes()).toHaveLength(0)
    // The raw status snapshot still reaches the renderer — only the fabricated
    // completion is suppressed.
    expect(emitted.some(([n, , p]) => n === 'event' && (p as { type?: string })?.type === 'status')).toBe(true)
  })

  it('DOES synthesize task_complete for the idle that ends the dispatched run', () => {
    // Same tab, but the engine advanced its counter: this idle is the run exit.
    const tab = makeTab({ activeRequestId: 'req-1', dispatchRunEpoch: 7, status: 'running' })

    handleEngineEvent(ctx, 'tab-001', tab, idleStatus(8))

    expect(taskCompletes()).toHaveLength(1)
  })

  it('does NOT synthesize task_complete before the run is confirmed on an engine without runEpoch', () => {
    // The currently-installed binary sends no epoch. A prompt is dispatched and
    // no state=running has arrived for it, so this idle predates the run.
    const tab = makeTab({ activeRequestId: 'req-1', status: 'running', dispatchAcknowledged: false })

    handleEngineEvent(ctx, 'tab-001', tab, idleStatus())

    expect(taskCompletes()).toHaveLength(0)
  })

  it('DOES synthesize task_complete once the engine has acknowledged the dispatch, with no runEpoch', () => {
    // Guards the opposite failure: refusing every idle while a prompt is in
    // flight would leave the conversation stuck in Working forever, which is
    // worse than the bug being fixed. submitPrompt sets dispatchAcknowledged
    // when the send RPC returns; from then on an idle is a real boundary.
    //
    // Deliberately NOT keyed on a preceding `state: 'running'`: a run that
    // produces no streaming work can go straight to idle, so keying on that
    // emission would wedge exactly those conversations.
    const tab = makeTab({ activeRequestId: 'req-1', status: 'running', dispatchAcknowledged: true })

    handleEngineEvent(ctx, 'tab-001', tab, idleStatus())

    expect(taskCompletes()).toHaveLength(1)
  })

  it('accepts a terminal idle that never had a preceding running emission', () => {
    // The regression the earlier draft of this guard would have caused: a run
    // acknowledged by the engine that reports idle without ever reporting
    // running must still complete.
    const tab = makeTab({ activeRequestId: 'req-2', status: 'connecting', dispatchAcknowledged: true })
    // 'connecting' has its own older skip, so drive the case the guard owns.
    tab.status = 'running'

    handleEngineEvent(ctx, 'tab-001', tab, idleStatus())

    expect(taskCompletes()).toHaveLength(1)
  })

  it('still synthesizes task_complete when no prompt is in flight', () => {
    // An idle arriving with no dispatch outstanding is unaffected by the guard.
    const tab = makeTab({ activeRequestId: null, status: 'running', dispatchRunEpoch: 7 })

    handleEngineEvent(ctx, 'tab-001', tab, idleStatus(7))

    expect(taskCompletes()).toHaveLength(1)
  })

  it('tracks the engine run epoch from every status, whatever the state', () => {
    // submitPrompt reads lastObservedRunEpoch as its ordering baseline, so the
    // handler must keep it fresh from running and idle emissions alike.
    const tab = makeTab({ status: 'running' })

    handleEngineEvent(ctx, 'tab-001', tab, runningStatus(4))
    expect(tab.lastObservedRunEpoch).toBe(4)

    handleEngineEvent(ctx, 'tab-001', tab, idleStatus(5))
    expect(tab.lastObservedRunEpoch).toBe(5)
  })

  it('keeps the last known epoch when a status omits the field', () => {
    // A single fieldless emission must not erase a baseline a live dispatch is
    // relying on.
    const tab = makeTab({ status: 'running', lastObservedRunEpoch: 9 })

    handleEngineEvent(ctx, 'tab-001', tab, runningStatus())

    expect(tab.lastObservedRunEpoch).toBe(9)
  })

  it('rebases onto a restarted session instead of refusing its snapshots', () => {
    // A session recreated by StartSession restarts its counter at zero. The
    // snapshot is from a new session, not a stale one.
    const tab = makeTab({ activeRequestId: 'req-1', dispatchRunEpoch: 12, status: 'running' })

    handleEngineEvent(ctx, 'tab-001', tab, idleStatus(0))

    expect(taskCompletes()).toHaveLength(1)
    expect(tab.dispatchRunEpoch).toBe(0)
  })
})
