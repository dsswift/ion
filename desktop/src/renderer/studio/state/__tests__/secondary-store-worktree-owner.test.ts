/**
 * environmentOfWorktreeRepo / environmentOfWorkspacePath — which machine a
 * worktree row was read from. The merged read model drops that, and a verb
 * started from a worktree row (a new conversation, a refresh, a land) has to
 * run on the machine that has the worktree.
 */
import { describe, expect, it, vi } from 'vitest'
import type { StudioWorktreeSnapshot } from '@ion/shared/types-studio'

vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: { setState: vi.fn() } }))
vi.mock('../../../rendererLogger', () => ({ rDebug: vi.fn(), rWarn: vi.fn() }))

import { environmentOfWorkspacePath, environmentOfWorktreeRepo, hydrateWorktreeFromSync } from '../secondary-store-worktree-sync'

const snapshot = (revision: number, repos: string[]): StudioWorktreeSnapshot => ({
  revision,
  ready: true,
  inventory: Object.fromEntries(repos.map((repo) => [repo, []])),
  workspaces: {},
  benchSourceTips: [],
  benchRetired: [],
  gitConflictAlerts: [],
  worktreePipeline: null,
  workspaceOperationLedger: [],
})

describe('environmentOfWorktreeRepo', () => {
  it('names the machine whose inventory has the repository, this machine first on a shared path', () => {
    // The remote snapshot arrives first; local must still win the shared path.
    hydrateWorktreeFromSync(snapshot(1, ['/Users/me/src/ion', '/home/g/src/tools']), 'devbox')
    hydrateWorktreeFromSync(snapshot(1, ['/Users/me/src/ion']), 'local')

    expect(environmentOfWorktreeRepo('/Users/me/src/ion')).toBe('local')
    expect(environmentOfWorktreeRepo('/home/g/src/tools')).toBe('devbox')
    expect(environmentOfWorktreeRepo('/nowhere')).toBeNull()
  })
})

describe('environmentOfWorkspacePath', () => {
  it('finds the machine by repository, bench repository, worktree path, or bench path', () => {
    const worktreePath = '/home/g/.ion/worktrees/tools-1a2b'
    const benchPath = '/home/g/.ion/integration/tools-main'
    hydrateWorktreeFromSync({
      ...snapshot(2, ['/home/g/src/tools']),
      inventory: { '/home/g/src/tools': [{ worktreePath, branchName: 'wt/tools-1a2b', sourceBranch: 'main', label: 'tools-1a2b', head: '', lastCommitSubject: '', isDirty: false, unlandedCommitCount: 0, needsSync: false, safeToDiscard: false }] },
      workspaces: { '/home/g/src/bench-only': [{ repoPath: '/home/g/src/bench-only', sourceBranch: 'main', benchPath, benchBranch: 'ion/bench/main', members: [], baseSha: '', lastBuiltAt: 0 }] },
    }, 'devbox')

    expect(environmentOfWorkspacePath('/home/g/src/tools')).toBe('devbox')
    expect(environmentOfWorkspacePath('/home/g/src/bench-only')).toBe('devbox')
    expect(environmentOfWorktreeRepo('/home/g/src/bench-only')).toBe('devbox')
    expect(environmentOfWorkspacePath(worktreePath)).toBe('devbox')
    expect(environmentOfWorkspacePath(benchPath)).toBe('devbox')
    expect(environmentOfWorkspacePath('/nowhere')).toBeNull()
  })
})
