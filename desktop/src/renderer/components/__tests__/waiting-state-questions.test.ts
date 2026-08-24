// @vitest-environment jsdom
/**
 * Waiting state must include an open Guided Questions round.
 *
 * `waitingStateOfPane` is the ONE fold every waiting indicator reads — the tab
 * status dot, the tab-pill rim, the Inbox partition, the Studio inbox row, the
 * workspace indicator, and the iOS snapshot projection. So a gap here goes
 * wrong everywhere at once.
 *
 * The gap this closes: AskUserQuestions denials are deliberately filtered out
 * of `permissionDenied` (event-slice-task.ts) so the wizard owns that surface
 * instead of a second competing card. But the fold read only
 * `permissionDenied`, so a conversation blocked on a question round reported
 * idle — it reached the Inbox looking like there was nothing to do, while the
 * singular AskUserQuestion card (which does populate permissionDenied) worked
 * correctly. The asymmetry was the tell.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const workflowsRef: { current: unknown[] } = { current: [] }

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ conversationPanes: new Map() }) },
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({}) },
}))
// activeQuestionsCount reads the store non-reactively via getState().
vi.mock('../../stores/questions-store', () => ({
  activeQuestionsCount: (tabId: string) =>
    workflowsRef.current.filter(
      (w) => (w as { sessionKey: string; phase: string }).sessionKey === tabId
        && (w as { phase: string }).phase !== 'terminal',
    ).length,
}))

import { waitingStateOfPane } from '../TabStripShared'
import type { ConversationPane } from '../../../shared/types-engine'

/** A pane with one instance and no pending denials. */
function idlePane(): ConversationPane {
  return {
    activeInstanceId: 'main',
    instances: [{ id: 'main', permissionDenied: null }],
  } as unknown as ConversationPane
}

/** A pane whose instance carries a denial for `toolName`. */
function paneWithDenial(toolName: string): ConversationPane {
  return {
    activeInstanceId: 'main',
    instances: [{ id: 'main', permissionDenied: { tools: [{ toolName }] } }],
  } as unknown as ConversationPane
}

beforeEach(() => {
  workflowsRef.current = []
})

describe('waitingStateOfPane — Guided Questions round', () => {
  it("reports 'question' for an open round even with NO permission denial", () => {
    // The defect: permissionDenied is empty by design for AskUserQuestions,
    // so this returned null and every indicator showed idle.
    workflowsRef.current = [{ sessionKey: 'tab-1', phase: 'collecting' }]

    expect(waitingStateOfPane(idlePane(), 'tab-1')).toBe('question')
  })

  it('reports idle once the round reaches terminal', () => {
    workflowsRef.current = [{ sessionKey: 'tab-1', phase: 'terminal' }]

    expect(waitingStateOfPane(idlePane(), 'tab-1')).toBeNull()
  })

  it('does not leak across conversations', () => {
    // A round open on another tab must not light this one up.
    workflowsRef.current = [{ sessionKey: 'tab-other', phase: 'collecting' }]

    expect(waitingStateOfPane(idlePane(), 'tab-1')).toBeNull()
  })

  it('outranks a plan proposal, matching the denial-based precedence', () => {
    workflowsRef.current = [{ sessionKey: 'tab-1', phase: 'review' }]

    expect(waitingStateOfPane(paneWithDenial('ExitPlanMode'), 'tab-1')).toBe('question')
  })
})

describe('waitingStateOfPane — existing behavior preserved', () => {
  it("still reports 'question' for a singular AskUserQuestion denial", () => {
    expect(waitingStateOfPane(paneWithDenial('AskUserQuestion'), 'tab-1')).toBe('question')
  })

  it("still reports 'plan-ready' for an ExitPlanMode denial", () => {
    expect(waitingStateOfPane(paneWithDenial('ExitPlanMode'), 'tab-1')).toBe('plan-ready')
  })

  it('reports null for an idle pane', () => {
    expect(waitingStateOfPane(idlePane(), 'tab-1')).toBeNull()
  })

  it('tolerates an absent tabId (non-questions callers)', () => {
    // The parameter is optional so a caller with no tab id in hand keeps
    // working; it simply cannot consult the questions store.
    expect(waitingStateOfPane(paneWithDenial('ExitPlanMode'))).toBe('plan-ready')
    expect(waitingStateOfPane(undefined)).toBeNull()
  })
})
