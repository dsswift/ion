/**
 * engine-control-plane-events — handleStatusEvent conversation-id guard tests
 *
 * These tests pin the B1 fix for issue #230: a post-restart pre-mint idle
 * event must NOT clobber an already-tracked conversationId.
 *
 * Also pins the duplicate-switch-arm fixes (#259):
 *   - engine_working_message must emit a working_message NormalizedEvent.
 *   - engine_notify (non-error level) must emit a notify NormalizedEvent.
 *   - engine_notify (error level) must emit BOTH error and notify NormalizedEvents.
 *   - engine_dialog must emit a dialog NormalizedEvent with dialogId.
 * Reverting any of those arms to the original no-op / error-only behavior
 * turns the relevant test red.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'

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
  trace: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

// conversationExists drives the divergence branch: a REAL tracked id (true)
// means drive a resume; a PHANTOM tracked id (false) means adopt the engine's
// minted id instead of looping. Default true so the existing #230 B1 tests
// (which assume the tracked conversation is real) keep their behavior; the
// phantom tests override per-case.
vi.mock('../session-meta', () => ({
  conversationExists: vi.fn(() => true),
}))

import { conversationExists } from '../session-meta'
const mockConversationExists = conversationExists as unknown as ReturnType<typeof vi.fn>

import { handleEngineEvent } from '../engine-control-plane-events'
import type { TabEntry, EventEmitterContext } from '../engine-control-plane-events'
import type { EngineEvent } from '../../shared/types'

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

function makeIdleEvent(sessionId: string): EngineEvent {
  return {
    type: 'engine_status',
    fields: {
      state: 'idle',
      sessionId,
      label: 'tab-001',
      runCostUsd: 0,
    },
  } as EngineEvent
}

describe('handleStatusEvent — conversationId guard (issue #230 B1)', () => {
  let mockBridge: any
  let ctx: EventEmitterContext
  let emitted: Array<[string, ...unknown[]]>

  beforeEach(() => {
    emitted = []
    mockConversationExists.mockReset().mockReturnValue(true)
    mockBridge = {
      updateSessionConversationId: vi.fn(),
      startSession: vi.fn().mockResolvedValue({ ok: true }),
      getSessionConfig: vi.fn().mockReturnValue(undefined),
    }
    ctx = {
      bridge: mockBridge as any,
      emit: (eventName: string, ...args: unknown[]) => { emitted.push([eventName, ...args]) },
      setStatus: vi.fn(),
      checkDrain: vi.fn(),
    }
  })

  it('adopts engine sessionId when tab has no conversationId (first bind)', () => {
    const tab = makeTab({ conversationId: null, status: 'running' })
    const event = makeIdleEvent('new-conv-id')

    handleEngineEvent(ctx, 'tab-001', tab, event)

    expect(tab.conversationId).toBe('new-conv-id')
    expect(mockBridge.updateSessionConversationId).toHaveBeenCalledWith('tab-001', 'new-conv-id')
    expect(mockBridge.startSession).not.toHaveBeenCalled()
  })

  it('no-op when engine sessionId matches tracked conversationId (heartbeat)', () => {
    const tab = makeTab({ conversationId: 'existing-conv-id', status: 'running' })
    const event = makeIdleEvent('existing-conv-id')

    handleEngineEvent(ctx, 'tab-001', tab, event)

    expect(tab.conversationId).toBe('existing-conv-id') // unchanged
    expect(mockBridge.updateSessionConversationId).toHaveBeenCalledWith('tab-001', 'existing-conv-id')
    expect(mockBridge.startSession).not.toHaveBeenCalled()
  })

  it('drives resume when engine sessionId diverges from tracked conversationId (post-restart pre-mint)', () => {
    const tab = makeTab({ conversationId: 'original-conv-id', status: 'running' })
    const event = makeIdleEvent('new-premint-id')

    handleEngineEvent(ctx, 'tab-001', tab, event)

    // Must NOT overwrite the tracked id.
    expect(tab.conversationId).toBe('original-conv-id')
    // Must drive a resume with the original id.
    expect(mockBridge.startSession).toHaveBeenCalledWith('tab-001', expect.objectContaining({
      sessionId: 'original-conv-id',
    }))
    // updateSessionConversationId is called with the ORIGINAL id, not the pre-mint.
    expect(mockBridge.updateSessionConversationId).toHaveBeenCalledWith('tab-001', 'original-conv-id')
  })

  it('divergence resume carries the tab real config, not empty placeholders (issue #231 Gap 2)', () => {
    // The bridge holds the last config used to start this session: a real
    // working directory, extensions, and model. The divergence resume must
    // reuse it (overriding only sessionId), not start a degraded empty session.
    mockBridge.getSessionConfig = vi.fn().mockReturnValue({
      profileId: 'default',
      extensions: ['ext-a', 'ext-b'],
      workingDirectory: '/work/project',
      model: 'claude-opus-4-8',
    })
    const tab = makeTab({ conversationId: 'original-conv-id', status: 'running' })
    const event = makeIdleEvent('new-premint-id')

    handleEngineEvent(ctx, 'tab-001', tab, event)

    expect(mockBridge.getSessionConfig).toHaveBeenCalledWith('tab-001')
    expect(mockBridge.startSession).toHaveBeenCalledWith('tab-001', expect.objectContaining({
      sessionId: 'original-conv-id',
      workingDirectory: '/work/project',
      extensions: ['ext-a', 'ext-b'],
      model: 'claude-opus-4-8',
      forceNewConversation: false,
    }))
  })

  it('divergence resume falls back to a minimal config when the bridge has no record', () => {
    // getSessionConfig returns undefined (default mock): the resume still
    // happens with the original id so the conversation is restored.
    const tab = makeTab({ conversationId: 'original-conv-id', status: 'running' })
    const event = makeIdleEvent('new-premint-id')

    handleEngineEvent(ctx, 'tab-001', tab, event)

    expect(mockBridge.startSession).toHaveBeenCalledWith('tab-001', expect.objectContaining({
      sessionId: 'original-conv-id',
    }))
  })

  // ── Phantom-divergence guard (#230/#231) ──
  //
  // When the engine's idle sessionId diverges from the tracked conversationId
  // AND the tracked id has NO backing file (a phantom — pre-minted on a prior
  // restart, never saved), driving a resume to it is futile: the engine now
  // ignores a fileless sessionId and pre-mints again, so re-pinning the phantom
  // spins the empty-conversation cascade that orphaned the morning's history.
  // The desktop must instead adopt the engine's minted id and stop.

  it('adopts the engine id (no resume) when the tracked conversationId is a PHANTOM (no file)', () => {
    mockConversationExists.mockReturnValue(false) // tracked id is a phantom.
    const tab = makeTab({ conversationId: 'phantom-conv-id', status: 'running' })
    const event = makeIdleEvent('engine-minted-real-id')

    handleEngineEvent(ctx, 'tab-001', tab, event)

    // The phantom is abandoned: the tab adopts the engine's minted id.
    expect(tab.conversationId).toBe('engine-minted-real-id')
    expect(mockBridge.updateSessionConversationId).toHaveBeenCalledWith('tab-001', 'engine-minted-real-id')
    // And it does NOT loop a resume back to the dead phantom.
    expect(mockBridge.startSession).not.toHaveBeenCalled()
  })

  it('still drives a resume when the tracked conversationId is REAL (file present)', () => {
    mockConversationExists.mockReturnValue(true) // tracked id is a real conversation.
    const tab = makeTab({ conversationId: 'real-conv-id', status: 'running' })
    const event = makeIdleEvent('new-premint-id')

    handleEngineEvent(ctx, 'tab-001', tab, event)

    // Real tracked id → drive the resume (existing #230 B1 behavior preserved).
    expect(tab.conversationId).toBe('real-conv-id')
    expect(mockBridge.startSession).toHaveBeenCalledWith('tab-001', expect.objectContaining({
      sessionId: 'real-conv-id',
    }))
    expect(mockBridge.updateSessionConversationId).toHaveBeenCalledWith('tab-001', 'real-conv-id')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate-arm fix tests (#259)
//
// Before the fix, the switch had two `case 'engine_working_message'` arms and
// two `case 'engine_notify'` arms. JS executes the FIRST matching arm only, so:
//   - engine_working_message first arm was a `break` no-op → no NormalizedEvent emitted.
//   - engine_notify first arm only fired for level==='error' → non-error notifications silently dropped.
//
// Revert check: restoring the no-op `break` for engine_working_message makes
// the working_message test fail (emitted.length === 0). Restoring the
// error-only guard for engine_notify makes the non-error notify test fail.
// ─────────────────────────────────────────────────────────────────────────────

describe('handleEngineEvent — duplicate-arm event emission (#259)', () => {
  let ctx: EventEmitterContext
  let emitted: Array<{ name: string; tabId: string; event: any }>

  beforeEach(() => {
    emitted = []
    ctx = {
      bridge: {
        updateSessionConversationId: vi.fn(),
        startSession: vi.fn().mockResolvedValue({ ok: true }),
        getSessionConfig: vi.fn().mockReturnValue(undefined),
      } as any,
      emit: (eventName: string, ...args: unknown[]) => {
        if (eventName === 'event') {
          emitted.push({ name: eventName, tabId: args[0] as string, event: args[1] })
        }
      },
      setStatus: vi.fn(),
      checkDrain: vi.fn(),
    }
  })

  // ── engine_working_message ────────────────────────────────────────────────

  it('engine_working_message emits a working_message NormalizedEvent', () => {
    // REVERT CHECK: restoring `case 'engine_working_message': break` makes
    // emitted.length === 0 and this test fails.
    const tab = makeTab()
    handleEngineEvent(ctx, 'tab-001', tab, {
      type: 'engine_working_message',
      message: 'Thinking about it…',
    } as any)

    expect(emitted).toHaveLength(1)
    expect(emitted[0].event.type).toBe('working_message')
    expect(emitted[0].event.message).toBe('Thinking about it…')
  })

  it('engine_working_message with empty message emits working_message with empty string', () => {
    const tab = makeTab()
    handleEngineEvent(ctx, 'tab-001', tab, {
      type: 'engine_working_message',
    } as any)

    expect(emitted).toHaveLength(1)
    expect(emitted[0].event.type).toBe('working_message')
    expect(emitted[0].event.message).toBe('')
  })

  // ── engine_notify ─────────────────────────────────────────────────────────

  it('engine_notify (info level) emits a notify NormalizedEvent', () => {
    // REVERT CHECK: restoring the error-only guard makes this produce
    // emitted.length === 0 and this test fails.
    const tab = makeTab()
    handleEngineEvent(ctx, 'tab-001', tab, {
      type: 'engine_notify',
      message: 'Build complete',
      level: 'info',
    } as any)

    expect(emitted).toHaveLength(1)
    expect(emitted[0].event.type).toBe('notify')
    expect(emitted[0].event.message).toBe('Build complete')
    expect(emitted[0].event.level).toBe('info')
  })

  it('engine_notify (warning level) emits a notify NormalizedEvent', () => {
    const tab = makeTab()
    handleEngineEvent(ctx, 'tab-001', tab, {
      type: 'engine_notify',
      message: 'Rate limited',
      level: 'warning',
    } as any)

    expect(emitted).toHaveLength(1)
    expect(emitted[0].event.type).toBe('notify')
    expect(emitted[0].event.level).toBe('warning')
  })

  it('engine_notify (error level) emits BOTH an error and a notify NormalizedEvent', () => {
    // The correct arm emits error first, then notify. Both must be present.
    const tab = makeTab()
    handleEngineEvent(ctx, 'tab-001', tab, {
      type: 'engine_notify',
      message: 'Extension crashed',
      level: 'error',
    } as any)

    expect(emitted).toHaveLength(2)
    const errorEv = emitted.find((e) => e.event.type === 'error')
    const notifyEv = emitted.find((e) => e.event.type === 'notify')
    expect(errorEv).toBeDefined()
    expect(errorEv!.event.isError).toBe(true)
    expect(notifyEv).toBeDefined()
    expect(notifyEv!.event.level).toBe('error')
  })

  // ── engine_dialog ─────────────────────────────────────────────────────────

  it('engine_dialog emits a dialog NormalizedEvent with dialogId', () => {
    // The first (now-removed) arm was missing dialogId; the correct arm
    // always emits dialogId. This ensures the correct arm is the one firing.
    const tab = makeTab()
    handleEngineEvent(ctx, 'tab-001', tab, {
      type: 'engine_dialog',
      dialogId: 'dlg-123',
      method: 'confirm',
      title: 'Proceed?',
      message: 'Are you sure?',
      options: ['Yes', 'No'],
      defaultValue: 'No',
    } as any)

    expect(emitted).toHaveLength(1)
    expect(emitted[0].event.type).toBe('dialog')
    expect(emitted[0].event.dialogId).toBe('dlg-123')
    expect(emitted[0].event.method).toBe('confirm')
    expect(emitted[0].event.title).toBe('Proceed?')
    expect(emitted[0].event.options).toEqual(['Yes', 'No'])
  })

  // ── engine_elicitation_request ────────────────────────────────────────────
  //
  // Regression for the dev-lead dispatch stall: an extension ctx.elicit()
  // emits engine_elicitation_request, which the desktop previously dropped
  // (no switch arm), parking the run on an indefinite human-wait. The arm
  // must translate it into an `elicitation_request` NormalizedEvent so the
  // renderer can show an approval card. Removing the arm turns this red.
  it('engine_elicitation_request emits an elicitation_request NormalizedEvent', () => {
    const tab = makeTab()
    handleEngineEvent(ctx, 'tab-001', tab, {
      type: 'engine_elicitation_request',
      requestId: 'elicit-42',
      elicitMode: 'approval',
      schema: { action: 'dispatch_agent', agent: 'dev-lead', tier: 'T4' },
      url: '',
    } as any)

    expect(emitted).toHaveLength(1)
    expect(emitted[0].event.type).toBe('elicitation_request')
    expect(emitted[0].event.requestId).toBe('elicit-42')
    expect(emitted[0].event.mode).toBe('approval')
    expect(emitted[0].event.schema).toEqual({ action: 'dispatch_agent', agent: 'dev-lead', tier: 'T4' })
  })
})

// ── session-ready idle vs. stale idle (profile-launch stuck-connecting fix) ──
//
// A conversation created from an engine profile opens blank: the renderer sets
// its tab to 'connecting' (createConversationTab) while the control-plane
// TabEntry is still 'idle'. The engine emits engine_status(starting)→(idle) as
// the session-ready signal with NO prompt ever dispatched. Before the fix the
// idle guard suppressed this ("skipping idle for idle/connecting tab"), so the
// renderer's 'connecting' was never cleared and the tab was stuck unusable
// (submit blocks on 'connecting').
//
// The fix: a never-run session (activeRequestId == null && startedAt === 0) is
// a session-ready idle — forward an 'idle' tab-status-change to the renderer
// WITHOUT synthesizing a task_complete. A run that is/was in flight
// (activeRequestId set OR startedAt !== 0) keeps the suppression that commit
// b16d5538 added for the Implement-flow stale-idle case.
describe('handleStatusEvent — session-ready idle clears connecting', () => {
  let ctx: EventEmitterContext
  let emitted: Array<{ name: string; args: unknown[] }>
  let setStatusCalls: Array<[string, string]>

  beforeEach(() => {
    emitted = []
    setStatusCalls = []
    ctx = {
      bridge: {
        updateSessionConversationId: vi.fn(),
        startSession: vi.fn().mockResolvedValue({ ok: true }),
        getSessionConfig: vi.fn().mockReturnValue(undefined),
      } as any,
      emit: (eventName: string, ...args: unknown[]) => { emitted.push({ name: eventName, args }) },
      setStatus: (tabId: string, newStatus: string) => { setStatusCalls.push([tabId, newStatus]) },
      checkDrain: vi.fn(),
    }
  })

  it('session-ready idle on a never-run idle tab forwards idle (no task_complete)', () => {
    // The profile-launch case at the control-plane layer: TabEntry is 'idle'
    // (default from createTab), no prompt ever dispatched.
    const tab = makeTab({ status: 'idle', activeRequestId: null, startedAt: 0 })
    handleEngineEvent(ctx, 'tab-001', tab, makeIdleEvent('conv-ready'))

    // Forwards an idle tab-status-change so the renderer (which may be sitting
    // in create-time 'connecting') reconciles to idle.
    const statusChange = emitted.find((e) => e.name === 'tab-status-change')
    expect(statusChange).toBeDefined()
    expect(statusChange!.args[0]).toBe('tab-001')
    expect(statusChange!.args[1]).toBe('idle')

    // Must NOT synthesize a task_complete for a session that ran nothing.
    const taskComplete = emitted.find(
      (e) => e.name === 'event' && (e.args[1] as any)?.type === 'task_complete',
    )
    expect(taskComplete).toBeUndefined()
  })

  it('session-ready idle on a never-run connecting tab forwards idle (no task_complete)', () => {
    // If the control-plane TabEntry is itself 'connecting' with no run, same
    // ready-idle path applies.
    const tab = makeTab({ status: 'connecting', activeRequestId: null, startedAt: 0 })
    handleEngineEvent(ctx, 'tab-001', tab, makeIdleEvent('conv-ready'))

    const statusChange = emitted.find((e) => e.name === 'tab-status-change')
    expect(statusChange).toBeDefined()
    expect(statusChange!.args[1]).toBe('idle')
    const taskComplete = emitted.find(
      (e) => e.name === 'event' && (e.args[1] as any)?.type === 'task_complete',
    )
    expect(taskComplete).toBeUndefined()
  })

  it('stale post-reset idle (run in flight) is still suppressed — b16d5538 guard', () => {
    // resetTabSession zeroed state, then submitPrompt set a fresh activeRequestId
    // + startedAt before the dying session's idle arrives. This must NOT forward
    // idle and must NOT synthesize task_complete (Implement-flow regression guard).
    const tab = makeTab({ status: 'connecting', activeRequestId: 'req-new', startedAt: Date.now() })
    handleEngineEvent(ctx, 'tab-001', tab, makeIdleEvent('conv-stale'))

    expect(emitted.find((e) => e.name === 'tab-status-change')).toBeUndefined()
    expect(
      emitted.find((e) => e.name === 'event' && (e.args[1] as any)?.type === 'task_complete'),
    ).toBeUndefined()
  })

  it('idle on a connecting tab with startedAt set (no activeRequestId) is still suppressed', () => {
    // A run that started (startedAt set) but cleared its requestId is in-flight
    // bookkeeping, not a never-run session — keep it suppressed.
    const tab = makeTab({ status: 'connecting', activeRequestId: null, startedAt: Date.now() })
    handleEngineEvent(ctx, 'tab-001', tab, makeIdleEvent('conv-x'))

    expect(emitted.find((e) => e.name === 'tab-status-change')).toBeUndefined()
  })

  it('heartbeat idle on a completed tab stays suppressed (card preserved)', () => {
    // A completed tab carries a pending AskUserQuestion/ExitPlanMode card; a
    // cost-only heartbeat idle must not clobber it (original b1284c11 intent).
    const tab = makeTab({ status: 'completed', activeRequestId: null, startedAt: 0 })
    handleEngineEvent(ctx, 'tab-001', tab, makeIdleEvent('conv-done'))

    expect(emitted.find((e) => e.name === 'tab-status-change')).toBeUndefined()
    expect(
      emitted.find((e) => e.name === 'event' && (e.args[1] as any)?.type === 'task_complete'),
    ).toBeUndefined()
  })

  it('genuine run completion (running tab) still synthesizes task_complete', () => {
    // A tab that actually ran (status 'running', startedAt set) must still get
    // its task_complete on the engine's idle — the fix must not swallow real
    // completions.
    const tab = makeTab({ status: 'running', activeRequestId: 'req-1', startedAt: Date.now() - 1000 })
    handleEngineEvent(ctx, 'tab-001', tab, makeIdleEvent('conv-run'))

    expect(
      emitted.find((e) => e.name === 'event' && (e.args[1] as any)?.type === 'task_complete'),
    ).toBeDefined()
  })
})
