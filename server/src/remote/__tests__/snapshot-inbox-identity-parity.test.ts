/**
 * Pins the two identity fields the iOS inbox needs for desktop-parity grouping
 * and sorting:
 *
 *   - `createdAt` — the "Newest created" sort key. Without it iOS can offer
 *     only two of the desktop's three sort options.
 *   - `worktree` — explicit worktree identity. iOS groups a worktree tab under
 *     its SOURCE repository by `worktree.repoPath`, exactly as the desktop
 *     navigator does (inbox-grouping.ts inboxProjectFor). Path-prefix guessing
 *     misfiles a freshly created worktree the inventory has not crawled yet.
 *
 * Both fields ride projectRendererTab (the wire contract owner).
 */
import { describe, expect, it } from 'vitest'
import { projectRendererTab } from '../snapshot-project'

const OPTS = { lastMessage: null, permissionQueue: [] }

describe('inbox identity projection parity', () => {
  it('projects createdAt onto the wire', () => {
    const out = projectRendererTab({ id: 't1', createdAt: 1234567 }, OPTS)
    expect(out.createdAt).toBe(1234567)
  })

  it('omits createdAt when the tab predates the field', () => {
    const out = projectRendererTab({ id: 't1' }, OPTS)
    expect(out.createdAt).toBeUndefined()
  })

  it('preserves an explicit false unread value on the wire', () => {
    const out = projectRendererTab({ id: 't1', unread: false }, OPTS)
    expect(out.unread).toBe(false)
  })

  it('projects the full worktree identity onto the wire', () => {
    const worktree = {
      worktreePath: '/Users/u/.ion/worktrees/repo-abc123',
      branchName: 'wt/repo-abc123',
      sourceBranch: 'main',
      repoPath: '/Users/u/src/repo',
      landedAt: 999,
    }
    const out = projectRendererTab({ id: 't1', worktree }, OPTS)
    expect(out.worktree).toEqual(worktree)
  })

  it('omits worktree for repo-root conversations', () => {
    const out = projectRendererTab({ id: 't1' }, OPTS)
    expect(out.worktree).toBeUndefined()
  })
})
