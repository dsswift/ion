/**
 * resolveRestoredWorkingDirectory — a restored session starts in the tab's
 * worktree, not in a stale persisted path.
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 * A create-order defect persisted five worktree conversations with
 * `workingDirectory` pointing at the shared base checkout while each tab carried
 * a correct `worktree.worktreePath`. The tab-state restore path already
 * preferred the worktree, but the EAGER SESSION START read the raw persisted
 * value — so every restart put those sessions back in the base repo and the
 * conversations kept interleaving in one checkout.
 *
 * The rule: when a tab has a worktree record, that record decides the directory.
 * The persisted `workingDirectory` is only authoritative for a tab that never
 * had a worktree.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../rendererLogger', () => ({
  rDebug: vi.fn(), rInfo: vi.fn(), rWarn: vi.fn(), rError: vi.fn(), rTrace: vi.fn(),
}))
import { resolveRestoredWorkingDirectory } from '../useTabRestoration-helpers'
import { resolveRegisteredWorktree } from '../../stores/worktree-registration'
import type { PersistedTab } from '../../../shared/types'

const REPO = '/Users/test/project'
const WORKTREE = '/Users/test/.ion/worktrees/project-a3f1'

function tab(over: Partial<PersistedTab>): PersistedTab {
  return { id: 't1', workingDirectory: REPO, ...over } as PersistedTab
}

describe('resolveRestoredWorkingDirectory', () => {
  // THE regression case: this is the exact on-disk shape the five affected
  // conversations had.
  it('prefers the worktree over a stale persisted repo path', () => {
    const t = tab({
      workingDirectory: REPO,
      worktree: { worktreePath: WORKTREE, branchName: 'wt/a', sourceBranch: 'josh', repoPath: REPO },
    })
    expect(resolveRestoredWorkingDirectory(t, true)).toBe(WORKTREE)
  })

  it('falls back to the repo when the worktree is gone from disk', () => {
    // Never the stale persisted path — that could BE the dead worktree.
    const t = tab({
      workingDirectory: WORKTREE,
      worktree: { worktreePath: WORKTREE, branchName: 'wt/a', sourceBranch: 'josh', repoPath: REPO },
    })
    expect(resolveRestoredWorkingDirectory(t, false)).toBe(REPO)
  })

  it('keeps a settled record bound to its retired worktree', () => {
    const t = tab({
      workingDirectory: WORKTREE,
      settledOverride: 'settled',
      worktree: { worktreePath: WORKTREE, branchName: 'wt/a', sourceBranch: 'josh', repoPath: REPO },
    })
    expect(resolveRestoredWorkingDirectory(t, false)).toBe(WORKTREE)
  })

  it('keeps the persisted directory for a tab that never had a worktree', () => {
    expect(resolveRestoredWorkingDirectory(tab({ workingDirectory: REPO }), false)).toBe(REPO)
  })

  it('repairs a persisted worktree path whose metadata is missing', async () => {
    ;(globalThis as { window?: unknown }).window = {
      ion: {
        gitWorktreeRegistration: vi.fn().mockResolvedValue({ registration: {
          repoPath: REPO, branchName: 'wt/a', sourceBranch: 'josh', title: null,
        } }),
      },
    }
    const persisted = tab({ workingDirectory: WORKTREE, worktree: null })

    const repaired = await resolveRegisteredWorktree(persisted.workingDirectory, persisted.worktree)

    expect(repaired).toEqual({
      worktreePath: WORKTREE, branchName: 'wt/a', sourceBranch: 'josh', repoPath: REPO,
    })
    expect(resolveRestoredWorkingDirectory({ ...persisted, worktree: repaired }, true)).toBe(WORKTREE)
  })

  it('is a no-op when the persisted path already agrees with the worktree', () => {
    const t = tab({
      workingDirectory: WORKTREE,
      worktree: { worktreePath: WORKTREE, branchName: 'wt/a', sourceBranch: 'josh', repoPath: REPO },
    })
    expect(resolveRestoredWorkingDirectory(t, true)).toBe(WORKTREE)
  })
})
