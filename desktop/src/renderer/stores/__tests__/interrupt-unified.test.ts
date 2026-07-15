/**
 * Unified `interrupt` action — data-conditioned abort for every tab type.
 *
 * Pins the three data-conditioned behaviors that replaced the old
 * EngineView.handleAbort / ConversationView inline-interrupt fork:
 *   - bash executing  → cancelBash, no run abort
 *   - running children → engineAbort + engineAbortAgent(subtree)
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
const mockEngineAbortAgent = vi.fn().mockResolvedValue(undefined)
const mockCancelBash = vi.fn()

beforeEach(() => {
  mockEngineAbort.mockClear()
  mockEngineAbortAgent.mockClear()
  mockCancelBash.mockClear()
  ;(globalThis as any).window = {
    ...(globalThis as any).window,
    ion: {
      engineAbort: mockEngineAbort,
      engineAbortAgent: mockEngineAbortAgent,
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
    expect(mockEngineAbortAgent).not.toHaveBeenCalled()
  })

  it('reaps the agent subtree when there are running children', () => {
    const state = harness({ id: 'tab1', status: 'running', bashExecId: null }, [{ status: 'running' }])
    state.interrupt('tab1')
    expect(mockEngineAbort).toHaveBeenCalledWith('tab1')
    expect(mockEngineAbortAgent).toHaveBeenCalledWith('tab1', '', true)
  })

  it('aborts only (no subtree reap) when there are no running children', () => {
    const state = harness({ id: 'tab1', status: 'running', bashExecId: null }, [{ status: 'done' }])
    state.interrupt('tab1')
    expect(mockEngineAbort).toHaveBeenCalledWith('tab1')
    expect(mockEngineAbortAgent).not.toHaveBeenCalled()
  })

  it('is a no-op for an unknown tab', () => {
    const state = harness({ id: 'tab1', status: 'running', bashExecId: null })
    state.interrupt('nonexistent')
    expect(mockEngineAbort).not.toHaveBeenCalled()
    expect(mockCancelBash).not.toHaveBeenCalled()
  })
})
