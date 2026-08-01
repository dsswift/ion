/**
 * Closing a worktree conversation must NEVER destroy the worktree, and must say
 * what is being left behind.
 *
 * ── The defect ──────────────────────────────────────────────────────────────
 * `closeTab` called `gitWorktreeRemove(..., force = true)`, and the remove
 * handler followed with `git branch -D`. A stray Cmd+W destroyed uncommitted
 * changes and made unlanded commits unreachable — silently, with no prompt and
 * no recovery path (there is no conversation history feature to fall back on).
 *
 * `setBaseDirectory` had the same shape, gated on a zero message count. That
 * inference is unsound: an agent can commit real work without the conversation
 * accumulating messages, so message count is not a proxy for "contains no work".
 *
 * These tests fail against both old implementations.
 *
 * Moved here from `main/__tests__/` with the module: the consumer is the
 * renderer's close-intent action, and the renderer may not import from `main/`.
 */
import { describe, it, expect } from 'vitest'

import { decideWorktreeClose } from '../worktree-close-decision'
import type { WorktreeAppraisalWire } from '../types-git'

const WT = '/Users/test/.ion/worktrees/ion-a3f1'

function appraisal(over: Partial<WorktreeAppraisalWire> = {}): WorktreeAppraisalWire {
  return {
    hasUncommittedChanges: false,
    uncommittedPaths: [],
    unlandedCommitCount: 0,
    fullyLanded: true,
    safeToDiscard: true,
    ...over,
  }
}

describe('decideWorktreeClose', () => {
  // The invariant, asserted directly for every input shape below.
  it('never removes the worktree, whatever the state', () => {
    const inputs: Array<WorktreeAppraisalWire | null> = [
      appraisal(),
      appraisal({ hasUncommittedChanges: true, uncommittedPaths: ['a.ts'], safeToDiscard: false }),
      appraisal({ unlandedCommitCount: 4, fullyLanded: false, safeToDiscard: false }),
      appraisal({ appraisalFailed: true, safeToDiscard: false }),
      null,
    ]
    for (const input of inputs) {
      expect(decideWorktreeClose(WT, input).removeWorktree).toBe(false)
    }
  })

  it('closes quietly when everything is committed and landed', () => {
    const decision = decideWorktreeClose(WT, appraisal())

    expect(decision.shouldWarn).toBe(false)
    expect(decision.summary).toBeUndefined()
  })

  it('warns about uncommitted files and says nothing is deleted', () => {
    const decision = decideWorktreeClose(WT, appraisal({
      hasUncommittedChanges: true,
      uncommittedPaths: ['src/a.ts', 'src/b.ts'],
      safeToDiscard: false,
    }))

    expect(decision.shouldWarn).toBe(true)
    expect(decision.summary).toContain('2 uncommitted files')
    // Reassurance matters as much as the warning: the operator must know the
    // close is not destructive and how to get back.
    expect(decision.summary).toMatch(/nothing is deleted/i)
    expect(decision.summary).toMatch(/Worktrees list/i)
  })

  it('warns about unlanded commits', () => {
    const decision = decideWorktreeClose(WT, appraisal({
      unlandedCommitCount: 4,
      fullyLanded: false,
      safeToDiscard: false,
    }))

    expect(decision.shouldWarn).toBe(true)
    expect(decision.summary).toContain('4 commits not yet landed')
  })

  it('reports both problems together', () => {
    const decision = decideWorktreeClose(WT, appraisal({
      hasUncommittedChanges: true,
      uncommittedPaths: ['a.ts'],
      unlandedCommitCount: 1,
      fullyLanded: false,
      safeToDiscard: false,
    }))

    expect(decision.summary).toContain('1 uncommitted file')
    expect(decision.summary).toContain('1 commit not yet landed')
  })

  // An unknown state warns rather than staying silent: a needless warning
  // costs a click, a missed one costs the operator walking away from work they
  // did not know was there.
  it('warns when the appraisal could not be completed', () => {
    for (const input of [null, appraisal({ appraisalFailed: true, safeToDiscard: false })]) {
      const decision = decideWorktreeClose(WT, input)
      expect(decision.shouldWarn).toBe(true)
      expect(decision.summary).toMatch(/could not be verified|still exists/i)
    }
  })

  it('singularises a single file and commit', () => {
    const decision = decideWorktreeClose(WT, appraisal({
      hasUncommittedChanges: true,
      uncommittedPaths: ['only.ts'],
      safeToDiscard: false,
    }))

    expect(decision.summary).toContain('1 uncommitted file.')
    expect(decision.summary).not.toContain('1 uncommitted files')
  })

  it('carries the worktree path so the UI can say where the work is', () => {
    expect(decideWorktreeClose(WT, appraisal()).worktreePath).toBe(WT)
  })
})
