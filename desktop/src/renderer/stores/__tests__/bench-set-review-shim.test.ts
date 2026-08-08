/**
 * Deprecated `benchSetReview` shim — verdict→stage forwarding.
 *
 * Sibling branches cut before the work-stage system still call
 * `benchSetReview` from WorktreeRowMenu.tsx (wt/ion-98d550f3, wt/ion-d2101138,
 * wt/ion-c151d648, wt/ion-02804dd4). The integration bench merges those call
 * sites against this branch's removal with no textual conflict, so the shim is
 * what keeps the assembled bench compiling and behaving. These tests pin the
 * forwarding contract: they fail if the shim is removed before the callers
 * migrate, and they fail if the shim's mapping ever drifts from the shared
 * `legacyReviewToStage` table the load migration uses.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

import { createWorktreeInventorySlice } from '../slices/worktree-inventory-slice'
import { legacyReviewToStage } from '../../../shared/types-git'
import type { State } from '../session-store-types'

const REPO = '/Users/test/project'
const WT = '/wt/a'

function harness() {
  const setWorktreeStage = vi.fn().mockResolvedValue(undefined)
  let state: Record<string, unknown> = {}
  const set = (fn: (s: Record<string, unknown>) => Record<string, unknown>): void => {
    state = { ...state, ...fn(state) }
  }
  // The shim delegates to the store's own setWorktreeStage action, so the
  // harness intercepts at that seam — the most stable boundary, and the one
  // that proves the delegation regardless of what the action does inside.
  const get = (): Record<string, unknown> => ({ ...state, setWorktreeStage })

  const slice = createWorktreeInventorySlice(
    set as never, get as never,
  ) as Pick<State, 'benchSetReview'>

  return { slice, setWorktreeStage }
}

describe('benchSetReview forwards to setWorktreeStage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('maps good to verified', async () => {
    const { slice, setWorktreeStage } = harness()
    await slice.benchSetReview(REPO, 'josh', WT, 'good')
    expect(setWorktreeStage).toHaveBeenCalledWith(REPO, WT, 'verified')
  })

  it('maps issue to bug', async () => {
    const { slice, setWorktreeStage } = harness()
    await slice.benchSetReview(REPO, 'josh', WT, 'issue')
    expect(setWorktreeStage).toHaveBeenCalledWith(REPO, WT, 'bug')
  })

  it('maps null to a clear', async () => {
    const { slice, setWorktreeStage } = harness()
    await slice.benchSetReview(REPO, 'josh', WT, null)
    expect(setWorktreeStage).toHaveBeenCalledWith(REPO, WT, null)
  })
})

describe('legacyReviewToStage (the one shared table)', () => {
  // The preload shim and the workspaces-file load migration both read this
  // function; pinning it here pins them both.
  it('maps the legacy vocabulary and drops unknowns', () => {
    expect(legacyReviewToStage('good')).toBe('verified')
    expect(legacyReviewToStage('issue')).toBe('bug')
    expect(legacyReviewToStage(null)).toBeNull()
    expect(legacyReviewToStage('maybe')).toBeUndefined()
    expect(legacyReviewToStage(undefined)).toBeUndefined()
  })
})
