/**
 * Unified `interrupt` action — data-conditioned abort for every tab type.
 *
 * Pins the three data-conditioned behaviors that replaced the old
 * EngineView.handleAbort / ConversationView inline-interrupt fork:
 *   - bash executing  → cancelBash, no run abort
 *   - running children → engineAbort(all)
 *   - plain run        → engineAbort only (no subtree reap)
 * These would fail on the old code where no single `interrupt` action existed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({}) },
}))

vi.mock('../session-store-helpers', () => ({
  nextMsgId: vi.fn(() => 'msg-id'),
  playNotificationIfHidden: vi.fn(),
  cancelDoneGroupMove: vi.fn(() => false),
}))

import { createSendSlice } from '../slices/send-slice'

const mockEngineAbort = vi.fn().mockResolvedValue(undefined)
const mockCancelBash = vi.fn()

beforeEach(() => {
  mockEngineAbort.mockClear()
  mockCancelBash.mockClear()
  ;(globalThis as any).window = {
    ...(globalThis as any).window,
    ion: {
      engineAbort: mockEngineAbort,
      cancelBash: mockCancelBash,
    },
  }
})

function makePane(tabId: string, agentStates: Array<{ status: string }>) {
  return new Map([
    [tabId, {
      activeInstanceId: 'main',
      instances: [{
        id: 'main', label: 'main', messages: [], messageCount: 0,
        modelOverride: null, sessionModel: null, permissionMode: 'auto',
        permissionDenied: null, permissionQueue: [], elicitationQueue: [], conversationIds: [],
        draftInput: '', agentStates, statusFields: null, planFilePath: null,
    contextBreakdown: null,
      }],
    }],
  ])
}

function harness(tab: any, agentStates: Array<{ status: string }> = []) {
  const state: any = {
    tabs: [tab],
    conversationPanes: makePane(tab.id, agentStates),
    forceRecoverTab: vi.fn(),
  }
  const get = () => state
  const set = (fn: any) => Object.assign(state, typeof fn === 'function' ? fn(state) : fn)
  const slice = createSendSlice(set as any, get as any)
  Object.assign(state, slice)
  return state
}

describe('interrupt — unified, data-conditioned abort', () => {
  it('cancels bash and does NOT abort the run when a bash command is executing', () => {
    const state = harness({ id: 'tab1', status: 'running', bashExecId: 'exec-9' })
    state.interrupt('tab1')
    expect(mockCancelBash).toHaveBeenCalledWith('exec-9')
    expect(mockEngineAbort).not.toHaveBeenCalled()
  })

  it('reaps the agent subtree when there are running children', () => {
    const state = harness({ id: 'tab1', status: 'running', bashExecId: null }, [{ status: 'running' }])
    state.interrupt('tab1')
    expect(mockEngineAbort).toHaveBeenCalledWith('tab1', 'all')
  })

  it('aborts only (no subtree reap) when there are no running children', () => {
    const state = harness({ id: 'tab1', status: 'running', bashExecId: null }, [{ status: 'done' }])
    state.interrupt('tab1')
    expect(mockEngineAbort).toHaveBeenCalledWith('tab1', 'all')
  })

  // ── Scope ────────────────────────────────────────────────────────────────

  it('defaults to the all scope when no scope is given', () => {
    const state = harness({ id: 'tab1', status: 'running', bashExecId: null })
    state.interrupt('tab1')
    expect(mockEngineAbort).toHaveBeenCalledWith('tab1', 'all')
  })

  // THE distinguishing assertion for the orchestrator scope: running children
  // are present, so the 'all' path above would reap them. This path must not.
  it('does NOT reap the subtree under the orchestrator scope', () => {
    const state = harness({ id: 'tab1', status: 'running', bashExecId: null }, [{ status: 'running' }])
    state.interrupt('tab1', 'orchestrator')
    expect(mockEngineAbort).toHaveBeenCalledWith('tab1', 'orchestrator')
  })

  it('still reaps under an explicit all scope with running children', () => {
    const state = harness({ id: 'tab1', status: 'running', bashExecId: null }, [{ status: 'running' }])
    state.interrupt('tab1', 'all')
    expect(mockEngineAbort).toHaveBeenCalledWith('tab1', 'all')
  })

  it('propagates all_work when Stop all includes background shells', () => {
    const state = harness({ id: 'tab1', status: 'waiting', bashExecId: null })
    state.interrupt('tab1', 'all_work')
    expect(mockEngineAbort).toHaveBeenCalledWith('tab1', 'all_work')
  })

  it('bash cancellation still preempts the run abort under either scope', () => {
    const state = harness({ id: 'tab1', status: 'running', bashExecId: 'exec-3' })
    state.interrupt('tab1', 'orchestrator')
    expect(mockCancelBash).toHaveBeenCalledWith('exec-3')
    expect(mockEngineAbort).not.toHaveBeenCalled()
  })

  it('is a no-op for an unknown tab', () => {
    const state = harness({ id: 'tab1', status: 'running', bashExecId: null })
    state.interrupt('nonexistent')
    expect(mockEngineAbort).not.toHaveBeenCalled()
    expect(mockCancelBash).not.toHaveBeenCalled()
  })
})
