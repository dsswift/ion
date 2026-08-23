import { describe, expect, it, vi } from 'vitest'
import { resolveProjectIdentity } from '../project-identity'

function api(worktreeRepo: string | null, benchRepo: string | null) {
  return {
    gitWorktreeRegistration: vi.fn().mockResolvedValue({ registration: worktreeRepo ? { repoPath: worktreeRepo } : null }),
    benchResolvePath: vi.fn().mockResolvedValue({ workspace: benchRepo ? { repoPath: benchRepo } : null }),
  }
}

describe('resolveProjectIdentity', () => {
  it('uses persisted worktree metadata without IPC', async () => {
    const bridge = api(null, null)
    await expect(resolveProjectIdentity({ workingDirectory: '/worktree', worktree: { repoPath: '/repo' } }, bridge)).resolves.toBe('/repo')
    expect(bridge.gitWorktreeRegistration).not.toHaveBeenCalled()
  })

  it('repairs a legacy worktree from the registry', async () => {
    await expect(resolveProjectIdentity({ workingDirectory: '/worktree', worktree: null }, api('/repo', null))).resolves.toBe('/repo')
  })

  it('repairs a bench from the workspace store', async () => {
    await expect(resolveProjectIdentity({ workingDirectory: '/bench', worktree: null }, api(null, '/repo'))).resolves.toBe('/repo')
  })

  it('keeps an ordinary directory as its own project root', async () => {
    await expect(resolveProjectIdentity({ workingDirectory: '/project', worktree: null }, api(null, null))).resolves.toBe('/project')
  })
})
