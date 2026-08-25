/**
 * retireWorktree — refuse while work is live, then close every occupant.
 *
 * Split from worktree-inventory-slice.test.ts (file-size cap); the shared store
 * harness and `window.ion` mocks live in
 * `helpers/worktree-inventory-harness.ts` so the two suites cannot drift on what
 * the store looks like.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// The real preferences module touches localStorage/DOM, which this
// node-environment test does not have.
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ aiGeneratedTitles: false }) },
}))

vi.mock('../../rendererLogger', () => ({
  rInfo: vi.fn(), rDebug: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))

import {
  harness, ion, resetIon, entry, REPO, WT_A, WT_B, WT_A_SIBLING, BENCH,
  runningPane, agentsPane, shellPane, idlePane,
} from './helpers/worktree-inventory-harness'

beforeEach(resetIon)

describe('retireWorktree', () => {

  describe('refuses while anything in the worktree is active', () => {
    // THE ordering guarantee. Regression direction: move the pre-flight below
    // the IPC and this goes red — the directory is deleted, then the close is
    // refused.
    it('does not call the retire IPC at all when a conversation is running', async () => {
      const { state } = harness({
        tabs: [{ id: 'busy', workingDirectory: WT_A }],
        panes: new Map([['busy', runningPane]]),
      })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(res.ok).toBe(false)
      expect(ion.gitWorktreeDiscard).not.toHaveBeenCalled()
      expect(ion.gitWorktreeLandAndRetire).not.toHaveBeenCalled()
      expect(state.tabs).toHaveLength(1)
    })

    it('names the running conversation in the refusal', async () => {
      const { state } = harness({
        tabs: [{ id: 'busy', workingDirectory: WT_A, customTitle: 'Token expiry fix' } as any],
        panes: new Map([['busy', runningPane]]),
      })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(res.error).toContain('Token expiry fix')
      expect(res.error).toContain('running')
    })

    it('refuses on dispatched background agents and says how many', async () => {
      const { state } = harness({
        tabs: [{ id: 'busy', workingDirectory: WT_A, customTitle: 'Migration sweep' } as any],
        panes: new Map([['busy', agentsPane]]),
      })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(ion.gitWorktreeDiscard).not.toHaveBeenCalled()
      expect(ion.gitWorktreeLandAndRetire).not.toHaveBeenCalled()
      expect(res.error).toContain('Migration sweep')
      expect(res.error).toContain('2 background agents running')
    })

    it('refuses on outstanding background commands and says how many', async () => {
      const { state } = harness({
        tabs: [{ id: 'busy', workingDirectory: WT_A, customTitle: 'Release checks' } as any],
        panes: new Map([['busy', shellPane]]),
      })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(ion.gitWorktreeDiscard).not.toHaveBeenCalled()
      expect(ion.gitWorktreeLandAndRetire).not.toHaveBeenCalled()
      expect(res.error).toContain('1 background command running')
    })

    it('names EVERY active conversation, not just the first', async () => {
      const { state } = harness({
        tabs: [
          { id: 'one', workingDirectory: WT_A, customTitle: 'First' } as any,
          { id: 'two', workingDirectory: WT_A, customTitle: 'Second' } as any,
        ],
        panes: new Map([['one', runningPane], ['two', agentsPane]]),
      })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(res.error).toContain('First')
      expect(res.error).toContain('Second')
    })

    it('still refreshes the inventory so the row is not left stale', async () => {
      const { state } = harness({
        tabs: [{ id: 'busy', workingDirectory: WT_A }],
        panes: new Map([['busy', runningPane]]),
      })

      await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(ion.gitWorktreeInventory).toHaveBeenCalledWith(REPO)
    })

    it('refuses on a running conversation in a SUBDIRECTORY of the worktree', async () => {
      const { state } = harness({
        tabs: [{ id: 'busy', workingDirectory: `${WT_A}/desktop` }],
        panes: new Map([['busy', runningPane]]),
      })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(res.ok).toBe(false)
      expect(ion.gitWorktreeDiscard).not.toHaveBeenCalled()
      expect(ion.gitWorktreeLandAndRetire).not.toHaveBeenCalled()
    })

    // "Only that worktree" applies to the REFUSAL as much as to the close: a
    // busy conversation elsewhere must not block a retire that cannot touch it.
    it('ignores active work in a different worktree', async () => {
      const { state } = harness({
        tabs: [{ id: 'elsewhere', workingDirectory: WT_B }],
        panes: new Map([['elsewhere', runningPane]]),
      })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(res.ok).toBe(true)
      expect(ion.gitWorktreeDiscard).toHaveBeenCalled()
      expect(ion.gitWorktreeLandAndRetire).not.toHaveBeenCalled()
      expect(state.tabs).toHaveLength(1)
    })

    it('ignores active work in a prefix-sibling worktree', async () => {
      const { state } = harness({
        tabs: [{ id: 'sibling', workingDirectory: WT_A_SIBLING }],
        panes: new Map([['sibling', runningPane]]),
      })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(res.ok).toBe(true)
      expect(state.tabs.map((t: any) => t.id)).toEqual(['sibling'])
    })

    // A bench directory is deleted by a retire that empties it, so an active
    // conversation there is exactly as exposed as one in the worktree.
    it('refuses on active work in a bench this retire would prune', async () => {
      ion.gitWorktreeRetirePreview.mockResolvedValueOnce({ prunedBenchPaths: [BENCH] })
      const { state } = harness({
        tabs: [{ id: 'bench-tab', workingDirectory: BENCH, customTitle: 'Bench work' } as any],
        panes: new Map([['bench-tab', runningPane]]),
      })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(res.ok).toBe(false)
      expect(res.error).toContain('Bench work')
      expect(ion.gitWorktreeDiscard).not.toHaveBeenCalled()
      expect(ion.gitWorktreeLandAndRetire).not.toHaveBeenCalled()
    })

    it('ignores active work in a bench this retire would NOT prune', async () => {
      ion.gitWorktreeRetirePreview.mockResolvedValueOnce({ prunedBenchPaths: [] })
      const { state } = harness({
        tabs: [{ id: 'bench-tab', workingDirectory: BENCH }],
        panes: new Map([['bench-tab', runningPane]]),
      })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(res.ok).toBe(true)
      expect(state.tabs).toHaveLength(1)
    })

    it('proceeds when the occupant is idle', async () => {
      const { state } = harness({
        tabs: [{ id: 'idle', workingDirectory: WT_A }],
        panes: new Map([['idle', idlePane]]),
      })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(res.ok).toBe(true)
      expect(state.tabs).toHaveLength(0)
    })

    // A terminal has no conversation pane: no orchestrator, no dispatched
    // agents, nothing to wait for. It is closed, not protected.
    it('is never blocked by a terminal in the worktree', async () => {
      const { state } = harness({
        tabs: [{ id: 'term', workingDirectory: WT_A, isTerminalOnly: true } as any],
        panes: new Map(),
      })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(res.ok).toBe(true)
      expect(state.tabs).toHaveLength(0)
    })
  })

  describe('closes every occupant once the retire succeeds', () => {
    it('uses discard rather than landing the worktree first', async () => {
      const { state } = harness()

      const result = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(result.ok).toBe(true)
      expect(ion.gitWorktreeDiscard).toHaveBeenCalledWith({
        repoPath: REPO,
        worktreePath: WT_A,
        branchName: 'wt/a3f1',
        sourceBranch: 'josh',
      })
      expect(ion.gitWorktreeLandAndRetire).not.toHaveBeenCalled()
    })


    // The reported defect: `find` closed/relocated only the first.
    it('closes all conversations AND the terminal in the worktree', async () => {
      const { state } = harness({
        tabs: [
          { id: 'one', workingDirectory: WT_A },
          { id: 'two', workingDirectory: WT_A },
          { id: 'term', workingDirectory: WT_A, isTerminalOnly: true } as any,
        ],
      })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(res.ok).toBe(true)
      expect(state.tabs).toHaveLength(0)
      expect(state.closeTab).toHaveBeenCalledTimes(3)
    })

    it('closes an occupant in a subdirectory of the worktree', async () => {
      const { state } = harness({
        tabs: [{ id: 'nested', workingDirectory: `${WT_A}/desktop/src` }],
      })

      await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(state.tabs).toHaveLength(0)
    })

    // THE "only that worktree" assertion.
    it('leaves other worktrees, the base repo, and prefix siblings untouched', async () => {
      const { state } = harness({
        tabs: [
          { id: 'target', workingDirectory: WT_A },
          { id: 'other-wt', workingDirectory: WT_B },
          { id: 'repo', workingDirectory: REPO },
          { id: 'sibling', workingDirectory: WT_A_SIBLING },
        ],
      })

      await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(state.tabs.map((t: any) => t.id)).toEqual(['other-wt', 'repo', 'sibling'])
    })

    it('closes tabs in the benches the retire actually pruned', async () => {
      const OTHER_BENCH = '/Users/test/.ion/integration/project-other'
      ion.gitWorktreeDiscard.mockResolvedValueOnce({
        ok: true, workingDirectory: REPO, prunedBenchPaths: [BENCH],
      })
      const { state } = harness({
        tabs: [
          { id: 'wt', workingDirectory: WT_A },
          { id: 'bench', workingDirectory: BENCH },
          { id: 'other-bench', workingDirectory: OTHER_BENCH },
        ],
      })

      await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      // The unlisted bench survives: this retire did not remove it.
      expect(state.tabs.map((t: any) => t.id)).toEqual(['other-bench'])
    })

    it('closes nothing when the worktree has no occupants', async () => {
      const { state } = harness({ tabs: [{ id: 'repo', workingDirectory: REPO }] })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(res.ok).toBe(true)
      expect(state.closeTab).not.toHaveBeenCalled()
      expect(state.tabs).toHaveLength(1)
    })

    it('clears a pending close dialog for a tab it closed', async () => {
      const { state } = harness({
        tabs: [{ id: 'occupant', workingDirectory: WT_A }],
        closeIntent: { tabId: 'occupant' },
      })

      await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      // The intent named a tab that no longer exists; confirming it would be a
      // close of nothing.
      expect(state.closeIntent).toBeNull()
    })

    it('leaves a close dialog for an unrelated tab alone', async () => {
      const { state } = harness({
        tabs: [
          { id: 'occupant', workingDirectory: WT_A },
          { id: 'other', workingDirectory: REPO },
        ],
        closeIntent: { tabId: 'other' },
      })

      await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(state.closeIntent).toEqual({ tabId: 'other' })
    })
  })

  describe('a refused retire changes nothing', () => {
    it('closes no tabs when the retire itself refuses', async () => {
      ion.gitWorktreeDiscard.mockResolvedValueOnce({ ok: false, error: 'unlanded work' })
      const { state } = harness({ tabs: [{ id: 'occupant', workingDirectory: WT_A }] })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(res.ok).toBe(false)
      // The worktree still exists, so its conversation must stay in it.
      expect(state.tabs.map((t: any) => t.id)).toEqual(['occupant'])
      expect(state.closeTab).not.toHaveBeenCalled()
    })
  })

  describe('the check-to-retire race', () => {
    // An agent can start in the window between the pre-flight and the removal.
    // The directory is already gone by then, so the tab is relocated rather than
    // left on a dead path — the one job relocation still has.
    it('relocates a tab that became busy after the pre-flight', async () => {
      // `conversationId` set: relocation must move the LIVE engine session too,
      // and setTabWorkingDirectory correctly skips that for a tab that has never
      // started one.
      const { state } = harness({
        tabs: [{ id: 'racer', workingDirectory: WT_A, conversationId: 'conv-1' } as any],
      })
      // Idle at pre-flight; busy by the time closeTab runs.
      ion.gitWorktreeDiscard.mockImplementationOnce(async () => {
        state.conversationPanes.set('racer', runningPane)
        return { ok: true, workingDirectory: REPO, prunedBenchPaths: [] }
      })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(res.ok).toBe(true)
      // Still open (the guard refused), but no longer on the deleted path.
      expect(state.tabs).toHaveLength(1)
      expect(state.tabs[0].workingDirectory).toBe(REPO)
      expect(state.tabs[0].worktree).toBeNull()
      expect(ion.relocateTabSession).toHaveBeenCalledWith('racer', REPO)
    })
  })

  describe('the pruned-bench preview', () => {
    it('asks the main process rather than deriving the bench set locally', async () => {
      const { state } = harness()

      await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(ion.gitWorktreeRetirePreview).toHaveBeenCalledWith(WT_A)
    })

    // Fail safe on SCOPE, not open: with no prediction the worktree's own
    // occupants are still checked and closed.
    it('still checks the worktree when the preview throws', async () => {
      ion.gitWorktreeRetirePreview.mockRejectedValueOnce(new Error('boom'))
      const { state } = harness({
        tabs: [{ id: 'busy', workingDirectory: WT_A }],
        panes: new Map([['busy', runningPane]]),
      })

      const res = await state.retireWorktree(REPO, WT_A, 'wt/a3f1')

      expect(res.ok).toBe(false)
      expect(ion.gitWorktreeDiscard).not.toHaveBeenCalled()
      expect(ion.gitWorktreeLandAndRetire).not.toHaveBeenCalled()
    })
  })
})

describe('retireLandedWorktrees', () => {
  it('is a no-op when nothing in this repo has landed', async () => {
    const { state } = harness()
    state.worktreeInventory.set(REPO, [entry({ worktreePath: WT_A, landedAt: undefined })])

    const res = await state.retireLandedWorktrees(REPO)

    expect(res).toEqual({ ok: true, retired: 0 })
    expect(ion.gitWorktreeLandAndRetire).not.toHaveBeenCalled()
  })

  it('retires every landed worktree in the repo and leaves active ones alone', async () => {
    const { state } = harness()
    state.worktreeInventory.set(REPO, [
      entry({ worktreePath: WT_A, branchName: 'wt/a3f1', landedAt: 1000 }),
      entry({ worktreePath: WT_B, branchName: 'wt/7b0c', landedAt: 2000 }),
      entry({ worktreePath: '/Users/test/.ion/worktrees/project-active', branchName: 'wt/active', landedAt: undefined }),
    ])

    const res = await state.retireLandedWorktrees(REPO)

    expect(res).toEqual({ ok: true, retired: 2 })
    expect(ion.gitWorktreeLandAndRetire).toHaveBeenCalledTimes(2)
    expect(ion.gitWorktreeLandAndRetire).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: WT_A, branchName: 'wt/a3f1' }))
    expect(ion.gitWorktreeLandAndRetire).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: WT_B, branchName: 'wt/7b0c' }))
  })

  it('refuses the whole batch, retiring nothing, when any landed worktree has active work', async () => {
    const { state } = harness({
      tabs: [{ id: 'busy', workingDirectory: WT_B }],
      panes: new Map([['busy', runningPane]]),
    })
    state.worktreeInventory.set(REPO, [
      entry({ worktreePath: WT_A, branchName: 'wt/a3f1', landedAt: 1000 }),
      entry({ worktreePath: WT_B, branchName: 'wt/7b0c', landedAt: 2000 }),
    ])

    const res = await state.retireLandedWorktrees(REPO)

    expect(res.ok).toBe(false)
    expect(res.retired).toBe(0)
    expect(ion.gitWorktreeLandAndRetire).not.toHaveBeenCalled()
  })

  it('stops and reports the count already retired if a later retire in the batch fails', async () => {
    const { state } = harness()
    state.worktreeInventory.set(REPO, [
      entry({ worktreePath: WT_A, branchName: 'wt/a3f1', landedAt: 1000 }),
      entry({ worktreePath: WT_B, branchName: 'wt/7b0c', landedAt: 2000 }),
    ])
    ion.gitWorktreeLandAndRetire
      .mockResolvedValueOnce({ ok: true, workingDirectory: REPO, prunedBenchPaths: [] })
      .mockResolvedValueOnce({ ok: false, error: 'disk busy' })

    const res = await state.retireLandedWorktrees(REPO)

    expect(res.ok).toBe(false)
    expect(res.retired).toBe(1)
    expect(res.error).toBe('disk busy')
  })
})
