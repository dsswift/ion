import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, getOverlap, preview, applyPreview, solve, reorder, apply } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getOverlap: vi.fn(), preview: vi.fn(), applyPreview: vi.fn(), solve: vi.fn(), reorder: vi.fn(), apply: vi.fn(),
}))
vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) } }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn() }))
vi.mock('../../ipc-validation', () => ({ isValidProjectPath: vi.fn(() => true) }))
vi.mock('../../git-runner', () => ({ runGit: vi.fn() }))
vi.mock('../../worktree-overlap-window', () => ({ openWorktreeOverlapWindow: vi.fn(), worktreeOverlapContext: vi.fn(() => ({ repoPath: '/repo', sourceBranch: 'main' })) }))
vi.mock('../../worktree/overlap-service', () => ({ getWorktreeOverlap: (...args: unknown[]) => getOverlap(...args) }))
vi.mock('../../worktree/overlap-preview', () => ({ previewWorktreeOverlap: (...args: unknown[]) => preview(...args) }))
vi.mock('../../worktree/overlap-apply', () => ({ applyOverlapRecommendation: (...args: unknown[]) => apply(...args), previewOverlapApply: (...args: unknown[]) => applyPreview(...args) }))
vi.mock('../../worktree/overlap-recommendation', () => ({ reorderCurrentSelection: (...args: unknown[]) => reorder(...args), solveWorktreeOverlap: (...args: unknown[]) => solve(...args) }))

import { IPC } from '../../../shared/types'
import { registerWorktreeOverlapIpc } from '../worktree-overlap'

const analysis = { footprints: [{ worktreePath: '/repo/a' }] }
function invoke(channel: string, ...args: unknown[]): Promise<unknown> { return handlers.get(channel)!({ sender: { id: 1 } }, ...args) as Promise<unknown> }

beforeEach(() => {
  handlers.clear(); vi.clearAllMocks(); getOverlap.mockResolvedValue(analysis); registerWorktreeOverlapIpc()
})

describe('worktree overlap IPC validation', () => {
  it('rejects duplicate preview paths before analysis', async () => {
    await expect(invoke(IPC.WORKTREE_OVERLAP_PREVIEW, 'live', ['/repo/a', '/repo/a'])).resolves.toEqual({ error: 'Invalid overlap preview request.' })
    expect(getOverlap).not.toHaveBeenCalled()
  })
  it('rejects duplicate apply, apply-preview, and solver paths before analysis', async () => {
    await expect(invoke(IPC.WORKTREE_OVERLAP_APPLY, 'live', ['/repo/a', '/repo/a'])).resolves.toEqual({ ok: false, error: 'Invalid selection apply request.' })
    await expect(invoke(IPC.WORKTREE_OVERLAP_APPLY_PREVIEW, 'live', ['/repo/a', '/repo/a'])).resolves.toEqual({ error: 'Invalid selection preview request.' })
    await expect(invoke(IPC.WORKTREE_OVERLAP_SOLVE, 'live', ['/repo/a', '/repo/a'])).resolves.toEqual({ error: 'Invalid overlap solver request.' })
    expect(getOverlap).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
    expect(applyPreview).not.toHaveBeenCalled()
    expect(solve).not.toHaveBeenCalled()
  })

  it('rejects foreign preview, solve, and reorder paths', async () => {
    for (const channel of [IPC.WORKTREE_OVERLAP_PREVIEW, IPC.WORKTREE_OVERLAP_SOLVE, IPC.WORKTREE_OVERLAP_AUTO_ORDER]) {
      await expect(invoke(channel, 'live', ['/foreign'])).resolves.toEqual({ error: 'Selected worktree is not available in this overlap analysis.' })
    }
    expect(preview).not.toHaveBeenCalled()
    expect(solve).not.toHaveBeenCalled()
    expect(reorder).not.toHaveBeenCalled()
  })
})
