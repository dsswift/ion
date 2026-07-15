/**
 * autoRecoverStuckTab — the stuck-tab watchdog's auto-heal path (Layer D).
 *
 * Pins the operator's headline requirement: a tab that stalls is automatically
 * recovered by recreating the engine session in-process and resubmitting the
 * last prompt — the user is not asked to "resume", and the work continues.
 * Bounded by an attempt cap so a dead provider can't loop forever; after the
 * cap an honest message is surfaced via forceRecoverTab.
 *
 * These would all fail on the pre-fix code, where the watchdog called
 * forceRecoverTab (abort-only, "you can resume" message, no auto-resume).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../session-store-helpers', () => ({
  nextMsgId: vi.fn(() => 'msg-id'),
}))

import { createPermissionsSlice } from '../slices/permissions-slice'

const mockRestartTabSession = vi.fn()
const mockStopTab = vi.fn()

beforeEach(() => {
  mockRestartTabSession.mockClear()
  mockStopTab.mockClear()
  ;(globalThis as any).window = {
    ...(globalThis as any).window,
    ion: {
      // Stuck-tab recovery must use the NON-DESTRUCTIVE restart (preserves
      // conversationId), not the destructive resetTabSession. Mock restart and
      // assert it is the one called — if recovery regresses to resetTabSession,
      // this mock stays uncalled and the assertions fail.
      restartTabSession: mockRestartTabSession,
      stopTab: mockStopTab,
    },
  }
})

function makePane(tabId: string) {
  return new Map([
    [tabId, {
      activeInstanceId: 'main',
      instances: [{
        id: 'main', label: 'main', messages: [], messageCount: 0,
        modelOverride: null, sessionModel: null, permissionMode: 'auto',
        permissionDenied: null, permissionQueue: [], elicitationQueue: [], conversationIds: [],
        draftInput: '', agentStates: [], statusFields: null, planFilePath: null,
    contextBreakdown: null,
      }],
    }],
  ])
}

function harness(tab: any, pinnedPrompt?: string) {
  const submitCalls: Array<{ tabId: string; text: string }> = []
  const state: any = {
    tabs: [tab],
    conversationPanes: makePane(tab.id),
    enginePinnedPrompt: new Map(pinnedPrompt ? [[tab.id, pinnedPrompt]] : []),
    submit: (tabId: string, text: string) => submitCalls.push({ tabId, text }),
    submitCalls,
  }
  const get = () => state
  const set = (fn: any) => Object.assign(state, typeof fn === 'function' ? fn(state) : fn)
  const slice = createPermissionsSlice(set as any, get as any)
  Object.assign(state, slice)
  return state
}

describe('autoRecoverStuckTab — auto-heal + resume', () => {
  it('recreates the session and resubmits the last prompt (no engine restart)', () => {
    const state = harness({ id: 'tab1', status: 'running', activeRequestId: 'r1', conversationId: 'conv-1' }, 'implement the plan')
    const result = state.autoRecoverStuckTab('tab1')

    expect(result).toBe(true)
    // In-process session recreation, NOT an engine restart.
    expect(mockRestartTabSession).toHaveBeenCalledWith('tab1')
    // The last user prompt is resubmitted through the normal send path.
    expect(state.submitCalls).toEqual([{ tabId: 'tab1', text: 'implement the plan' }])
    // Run state reset to idle so submit starts a fresh run (not a steer).
    const tab = state.tabs.find((t: any) => t.id === 'tab1')
    expect(tab.status).toBe('idle')
    expect(tab.activeRequestId).toBeNull()
    expect(tab.autoRecoveryAttempts).toBe(1)
  })

  it('does NOT show the old misleading "you can resume" message', () => {
    const state = harness({ id: 'tab1', status: 'running', activeRequestId: 'r1' }, 'go')
    state.autoRecoverStuckTab('tab1')
    const inst = state.conversationPanes.get('tab1').instances[0]
    const texts = inst.messages.map((m: any) => m.content).join('\n')
    expect(texts).not.toContain('You can resume the conversation')
    expect(texts).not.toContain('The engine may have hung')
    // A quiet auto-resume line is acceptable.
    expect(texts).toContain('automatically resuming')
  })

  it('stops auto-resuming after the attempt cap and surfaces an honest message', () => {
    const state = harness({ id: 'tab1', status: 'running', activeRequestId: 'r1' }, 'go')
    // Two attempts succeed (cap = 2).
    expect(state.autoRecoverStuckTab('tab1')).toBe(true)
    expect(state.autoRecoverStuckTab('tab1')).toBe(true)
    // Third within the window hits the cap → falls back.
    const third = state.autoRecoverStuckTab('tab1')
    expect(third).toBe(false)
    // Only two resubmits ever happened.
    expect(state.submitCalls.length).toBe(2)
    // The honest, post-exhaustion message is present.
    const inst = state.conversationPanes.get('tab1').instances[0]
    const texts = inst.messages.map((m: any) => m.content).join('\n')
    expect(texts).toContain('automatic recovery did not succeed')
  })

  it('falls back to a plain reset when there is no last prompt to resume', () => {
    const state = harness({ id: 'tab1', status: 'running', activeRequestId: 'r1' }) // no pinned prompt
    const result = state.autoRecoverStuckTab('tab1')
    expect(result).toBe(false)
    expect(state.submitCalls.length).toBe(0)
    // stopTab is reached via forceRecoverTab's plain reset.
    expect(mockStopTab).toHaveBeenCalledWith('tab1')
  })

  it('is a no-op for an unknown tab', () => {
    const state = harness({ id: 'tab1', status: 'running', activeRequestId: 'r1' }, 'go')
    expect(state.autoRecoverStuckTab('nope')).toBe(false)
    expect(mockRestartTabSession).not.toHaveBeenCalled()
    expect(state.submitCalls.length).toBe(0)
  })

  it('does NOT resubmit when restartTabSession throws (no submit against a dead session)', () => {
    // Regression pin: the pre-fix code swallowed the reset failure with a bare
    // `catch {}` and then resubmitted unconditionally, sending a prompt into a
    // session that may not have been recreated. The fix logs the failure and
    // bails out (returns false) instead of resubmitting.
    mockRestartTabSession.mockImplementationOnce(() => {
      throw new Error('reset failed')
    })
    const state = harness({ id: 'tab1', status: 'running', activeRequestId: 'r1' }, 'implement the plan')
    const result = state.autoRecoverStuckTab('tab1')

    expect(result).toBe(false)
    expect(mockRestartTabSession).toHaveBeenCalledWith('tab1')
    // The critical assertion: no resubmit against a possibly-dead session.
    expect(state.submitCalls.length).toBe(0)
  })
})
