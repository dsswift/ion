/**
 * The validation the desktop's overlap IPC test pinned, now against the
 * `worktree.overlap.*` actions, plus the one thing that changed: the
 * repository context arrives as an explicit argument instead of being
 * looked up from the calling window.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  getOverlap: vi.fn(), preview: vi.fn(), applyPreview: vi.fn(), solve: vi.fn(), reorder: vi.fn(), apply: vi.fn(), runGit: vi.fn(async () => 'abc\n'),
}))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
vi.mock('../../ipc-validation', () => ({ isValidProjectPath: (p: unknown) => typeof p === 'string' && p.startsWith('/') }))
vi.mock('../../git/git-runner', () => ({ runGit: deps.runGit }))
vi.mock('../../worktree/overlap-service', () => ({ getWorktreeOverlap: (...args: unknown[]) => deps.getOverlap(...args) }))
vi.mock('../../worktree/overlap-preview', () => ({ previewWorktreeOverlap: (...args: unknown[]) => deps.preview(...args) }))
vi.mock('../../worktree/overlap-apply', () => ({ applyOverlapRecommendation: (...args: unknown[]) => deps.apply(...args), previewOverlapApply: (...args: unknown[]) => deps.applyPreview(...args) }))
vi.mock('../../worktree/overlap-recommendation', () => ({ reorderCurrentSelection: (...args: unknown[]) => deps.reorder(...args), solveWorktreeOverlap: (...args: unknown[]) => deps.solve(...args) }))

import { WORKTREE_OVERLAP_ACTIONS } from '../worktree-overlap-actions'
import type { Connection } from '../connection'

const conn = { id: 'c' } as unknown as Connection
const ctx = { repoPath: '/repo', sourceBranch: 'main' }
const analysis = { sourceBranch: 'main', footprints: [{ worktreePath: '/repo/a' }], recommendation: { kind: 'exact' } }
const run = (name: string, ...args: unknown[]) => WORKTREE_OVERLAP_ACTIONS[name].handler(conn, args)

beforeEach(() => { vi.clearAllMocks(); deps.getOverlap.mockResolvedValue(analysis) })

describe('worktree.overlap.* validation', () => {
  it('rejects a missing or invalid context before analysis', async () => {
    await expect(run('worktree.overlap.analyze', undefined, 'live')).resolves.toEqual({ ok: true, value: { error: 'Invalid overlap analysis request.' } })
    await expect(run('worktree.overlap.analyze', { repoPath: 'relative' }, 'live')).resolves.toEqual({ ok: true, value: { error: 'Invalid overlap analysis request.' } })
    await expect(run('worktree.overlap.analyze', { repoPath: '/repo', sourceBranch: 3 }, 'live')).resolves.toEqual({ ok: true, value: { error: 'Invalid overlap analysis request.' } })
    expect(deps.getOverlap).not.toHaveBeenCalled()
  })

  it('serves an analysis for the explicit context', async () => {
    await expect(run('worktree.overlap.analyze', ctx, 'pins')).resolves.toEqual({ ok: true, value: { analysis } })
    expect(deps.getOverlap).toHaveBeenCalledWith(ctx, 'pins')
  })

  it('rejects duplicate preview paths before analysis', async () => {
    await expect(run('worktree.overlap.preview', ctx, 'live', ['/repo/a', '/repo/a'])).resolves.toEqual({ ok: true, value: { error: 'Invalid overlap preview request.' } })
    expect(deps.getOverlap).not.toHaveBeenCalled()
  })

  it('rejects duplicate apply, apply-preview, and solver paths before analysis', async () => {
    await expect(run('worktree.overlap.apply', ctx, 'live', ['/repo/a', '/repo/a'])).resolves.toEqual({ ok: true, value: { ok: false, error: 'Invalid selection apply request.' } })
    await expect(run('worktree.overlap.applyPreview', ctx, 'live', ['/repo/a', '/repo/a'])).resolves.toEqual({ ok: true, value: { error: 'Invalid selection preview request.' } })
    await expect(run('worktree.overlap.solve', ctx, 'live', ['/repo/a', '/repo/a'])).resolves.toEqual({ ok: true, value: { error: 'Invalid overlap solver request.' } })
    expect(deps.getOverlap).not.toHaveBeenCalled()
    expect(deps.apply).not.toHaveBeenCalled()
    expect(deps.applyPreview).not.toHaveBeenCalled()
    expect(deps.solve).not.toHaveBeenCalled()
  })

  it('rejects foreign preview, solve, and reorder paths', async () => {
    await expect(run('worktree.overlap.preview', ctx, 'live', ['/repo/zzz'])).resolves.toEqual({ ok: true, value: { error: 'Selected worktree is not available in this overlap analysis.' } })
    await expect(run('worktree.overlap.solve', ctx, 'live', ['/repo/zzz'])).resolves.toEqual({ ok: true, value: { error: 'Selected worktree is not available in this overlap analysis.' } })
    await expect(run('worktree.overlap.autoOrder', ctx, 'live', ['/repo/zzz'])).resolves.toEqual({ ok: true, value: { error: 'Selected worktree is not available in this overlap analysis.' } })
    expect(deps.preview).not.toHaveBeenCalled()
    expect(deps.solve).not.toHaveBeenCalled()
    expect(deps.reorder).not.toHaveBeenCalled()
  })

  it('auto-order resolves the source branch tip and reorders with the recommendation kind', async () => {
    deps.reorder.mockResolvedValue({ orderedPaths: ['/repo/a'] })
    await expect(run('worktree.overlap.autoOrder', ctx, 'live', ['/repo/a'])).resolves.toEqual({ ok: true, value: { cohort: { orderedPaths: ['/repo/a'] } } })
    expect(deps.runGit).toHaveBeenCalledWith('/repo', ['rev-parse', 'main'])
    expect(deps.reorder).toHaveBeenCalledWith(analysis, 'abc', ['/repo/a'], 'exact')
  })

  it('apply hands the explicit context through and is the one git:write verb', async () => {
    deps.apply.mockResolvedValue({ ok: true })
    await expect(run('worktree.overlap.apply', ctx, 'live', ['/repo/a'])).resolves.toEqual({ ok: true, value: { ok: true } })
    expect(deps.apply).toHaveBeenCalledWith(ctx, 'live', ['/repo/a'])
    expect(WORKTREE_OVERLAP_ACTIONS['worktree.overlap.apply'].requiredScope).toBe('git:write')
    expect(WORKTREE_OVERLAP_ACTIONS['worktree.overlap.analyze'].requiredScope).toBe('conversations:read')
  })
})
