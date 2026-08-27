import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  setWorktreeLifecycleAutomationTrigger,
  triggerWorktreeLifecycleAutomation,
} from '../lifecycle-automation-trigger'

afterEach(() => setWorktreeLifecycleAutomationTrigger(null))

describe('worktree lifecycle automation trigger', () => {
  it('delivers persisted lifecycle facts to runtime', async () => {
    const onWorktreeLifecycleEvent = vi.fn().mockResolvedValue(undefined)
    setWorktreeLifecycleAutomationTrigger({ onWorktreeLifecycleEvent })

    await triggerWorktreeLifecycleAutomation('worktree:landed', {
      repoPath: '/repo', worktreePath: '/repo/wt', branchName: 'wt/test', sourceBranch: 'main', sha: 'abc123',
    })

    expect(onWorktreeLifecycleEvent).toHaveBeenCalledWith('worktree:landed', expect.objectContaining({
      worktreePath: '/repo/wt', sourceBranch: 'main', sha: 'abc123',
    }))
  })

  it('does nothing when no runtime is wired', async () => {
    await expect(triggerWorktreeLifecycleAutomation('worktree:retired', { worktreePath: '/repo/wt' })).resolves.toBeUndefined()
  })
})
