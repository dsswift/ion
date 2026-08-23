// @vitest-environment node
/**
 * Regression coverage for the detached-background-command defect, at the folds
 * that drive user-visible state.
 *
 * REPORTED: a detached `Bash({ run_in_background: true })` command ran for 96
 * seconds. The pink Bash operation group showed it running. Everything else
 * said done: composer badge absent, tab dot green, tab auto-moved to the Done
 * group, inbox filed as done.
 *
 * Each test below reverts to the pre-fix expression (`backgroundShells ?? 0`)
 * if the fold is changed back, so each one fails on the unfixed code.
 *
 * `hasPendingWorkInPane` is the single fold behind the Done-group auto-move
 * (event-slice-done-move.ts), and `evaluateSessionBusyGuard` is the single
 * predicate behind the close/convert/retire refusals and the inbox "working"
 * classification (inbox-collapse.ts `isInboxTabWorking`).
 */

import { describe, it, expect } from 'vitest'
import { hasPendingWorkInPane } from '../pending-work'
import { evaluateSessionBusyGuard, describeSessionBusyReason } from '../session-busy-guard'
import type { ConversationPane } from '../../../../shared/types-engine'

/** The exact engine snapshot for the reported task: live, but not parked on. */
const detachedStatusFields = {
  state: 'idle',
  backgroundAgents: 0,
  backgroundShells: 0,
  hasPendingWork: false,
  activeBackgroundTasks: [
    { taskId: 'bash-1-1787439682814', command: 'sleep 96', startedAt: 1787439682814, notifyOnComplete: false },
  ],
}

function paneWith(statusFields: unknown): ConversationPane {
  return {
    instances: [{ id: 'main', label: 'main', statusFields, agentStates: [] }],
  } as unknown as ConversationPane
}

describe('hasPendingWorkInPane — detached background command', () => {
  it('reports pending work for a detached live command (REGRESSION)', () => {
    // Pre-fix: hasPendingWork false, backgroundAgents 0, backgroundShells 0,
    // no running agents → false → the tab auto-moved to the Done group and the
    // auto-settle sweep was free to settle it, while the process still ran.
    expect(hasPendingWorkInPane(paneWith(detachedStatusFields))).toBe(true)
  })

  it('still reports pending work for a notifying command', () => {
    expect(hasPendingWorkInPane(paneWith({
      state: 'idle',
      backgroundShells: 1,
      hasPendingWork: true,
      activeBackgroundTasks: [{ taskId: 'a', command: 'c', startedAt: 1, notifyOnComplete: true }],
    }))).toBe(true)
  })

  it('reports no pending work once the command reaches terminal', () => {
    // The engine's terminal lifecycle event empties activeBackgroundTasks.
    // This is the arm that lets a genuinely-finished tab move to Done.
    expect(hasPendingWorkInPane(paneWith({
      state: 'idle',
      backgroundAgents: 0,
      backgroundShells: 0,
      hasPendingWork: false,
      activeBackgroundTasks: [],
    }))).toBe(false)
  })
})

describe('evaluateSessionBusyGuard — detached background command', () => {
  it('blocks close/convert while a detached command runs (REGRESSION)', () => {
    // StopBackgroundTasksForOwner kills detached processes too, so a close that
    // was allowed here silently destroyed a live 96-second command.
    const result = evaluateSessionBusyGuard(paneWith(detachedStatusFields))
    expect(result.blocked).toBe(true)
    expect(result.shellCount).toBe(1)
  })

  it('names the running command in the operator-facing refusal', () => {
    const reason = describeSessionBusyReason(evaluateSessionBusyGuard(paneWith(detachedStatusFields)))
    expect(reason).toBe('1 background command running')
  })

  it('allows the verb once no live process remains', () => {
    const result = evaluateSessionBusyGuard(paneWith({
      state: 'idle', backgroundShells: 0, hasPendingWork: false, activeBackgroundTasks: [],
    }))
    expect(result.blocked).toBe(false)
    expect(result.shellCount).toBe(0)
  })

  it('sums live processes across instances rather than max-ing them', () => {
    const pane = {
      instances: [
        {
          id: 'a', label: 'a', agentStates: [],
          statusFields: { state: 'idle', activeBackgroundTasks: [{ taskId: 'x', command: 'c', startedAt: 1, notifyOnComplete: false }] },
        },
        {
          id: 'b', label: 'b', agentStates: [],
          statusFields: { state: 'idle', activeBackgroundTasks: [{ taskId: 'y', command: 'd', startedAt: 2, notifyOnComplete: false }] },
        },
      ],
    } as unknown as ConversationPane
    // Separate instances own separate processes.
    expect(evaluateSessionBusyGuard(pane).shellCount).toBe(2)
  })
})
