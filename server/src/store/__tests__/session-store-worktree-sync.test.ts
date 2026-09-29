import { describe, expect, it } from 'vitest'
import { projectStudioWorktreeSnapshot } from '../session-store-worktree-sync'

describe('projectStudioWorktreeSnapshot', () => {
  it('publishes the complete owner workspace read model', () => {
    const snapshot = projectStudioWorktreeSnapshot({
      worktreeInventory: new Map([['/repo', [{ worktreePath: '/repo/feature' }]]]),
      benchWorkspaces: new Map([['/repo', [{ sourceBranch: 'main', benchPath: '/bench' }]]]),
      benchSourceTips: new Map([['/repo', { main: 'abc123' }]]),
      benchRetired: new Map([['/repo', new Map([['main', [{ branchName: 'feature' }]]])]]),
      gitConflictAlerts: new Map([['/repo/feature', {
        source: 'sync', dismissed: false, recordedAt: 10,
      }]]),
      worktreePipeline: null,
      workspaceOperationLedger: new Map([['sync:1', {
        id: 'sync:1', action: 'syncWorktree', status: 'running', startedAt: 20,
        worktreePath: '/repo/feature',
      }]]),
    } as never, true)

    expect(snapshot).toMatchObject({
      ready: true,
      inventory: { '/repo': [{ worktreePath: '/repo/feature' }] },
      workspaces: { '/repo': [{ sourceBranch: 'main', benchPath: '/bench' }] },
      benchSourceTips: [['/repo', { main: 'abc123' }]],
      gitConflictAlerts: [['/repo/feature', { source: 'sync' }]],
      workspaceOperationLedger: [{ id: 'sync:1', status: 'running' }],
    })
  })
})
