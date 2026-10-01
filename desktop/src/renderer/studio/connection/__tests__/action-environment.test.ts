/** Where a forwarded action goes: a named tab's environment, the machine holding a named worktree path, the active tab's for an action that acts on it, else local. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudioWorktreeSnapshot } from '@ion/shared/types-studio'
import type { IntegrationWorkspace, WorktreeInventoryEntry } from '@ion/shared/types'

const state: { tabs: Array<{ id: string; environmentId?: string }>; settledHistory: never[]; activeTabId: string | null } = { tabs: [], settledHistory: [], activeTabId: null }
vi.mock('@ion/server/store/sessionStore', () => ({ useSessionStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), { getState: () => state, setState: vi.fn() }) }))
vi.mock('../../../rendererLogger', () => ({ rDebug: vi.fn(), rWarn: vi.fn() }))

const { resolveActionEnvironment, activeTabIdForAction, withTargetEnvironment } = await import('../tab-environment')
const { hydrateWorktreeFromSync } = await import('../../state/secondary-store-worktree-sync')

describe('resolveActionEnvironment', () => {
  beforeEach(() => { state.tabs = [{ id: 'local-1' }, { id: 'oscar-1', environmentId: 'env-oscar' }]; state.activeTabId = 'oscar-1' })

  // A mode switch in a conversation on another environment went to the
  // local server and changed whichever conversation was active there.
  it('an action that acts on the active tab goes to the active tab\'s environment and carries its id', () => {
    for (const name of ['setPermissionMode', 'togglePermissionMode', 'setThinkingEffort', 'clearTab', 'addDirectory', 'removeDirectory', 'addAttachments', 'removeAttachment', 'clearAttachments']) {
      expect(resolveActionEnvironment(name, ['x'])).toBe('env-oscar')
      expect(activeTabIdForAction(name)).toBe('oscar-1')
    }
    state.activeTabId = 'local-1'
    expect(resolveActionEnvironment('setPermissionMode', ['auto'])).toBe('local')
  })

  it('a named tab still decides, and bookkeeping with no tab stays local', () => {
    expect(resolveActionEnvironment('settleTab', ['oscar-1'])).toBe('env-oscar')
    expect(resolveActionEnvironment('settleTab', ['local-1'])).toBe('local')
    expect(resolveActionEnvironment('reorderPinnedTabs', [[]])).toBe('local')
    expect(activeTabIdForAction('reorderPinnedTabs')).toBeUndefined()
  })
})

describe('resolveActionEnvironment: worktree verbs', () => {
  const worktree = { worktreePath: '/Users/r/.ion/worktrees/api-f83c', branchName: 'wt/api-f83c', sourceBranch: 'main', label: 'api-f83c', head: 'c7d25bd', lastCommitSubject: 'feat: add network', isDirty: false, unlandedCommitCount: 5, needsSync: false, safeToDiscard: false } satisfies WorktreeInventoryEntry
  const bench = { repoPath: '/Users/r/src/api', sourceBranch: 'main', benchPath: '/Users/r/.ion/integration/api-main', benchBranch: 'ion/bench/main', members: [], baseSha: 'b', lastBuiltAt: 0 } satisfies IntegrationWorkspace
  const snapshot = (revision: number, inventory: StudioWorktreeSnapshot['inventory'], workspaces: StudioWorktreeSnapshot['workspaces']): StudioWorktreeSnapshot => ({
    revision, ready: true, inventory, workspaces, benchSourceTips: [], benchRetired: [], gitConflictAlerts: [], worktreePipeline: null, workspaceOperationLedger: [],
  })

  beforeEach(() => {
    state.tabs = []
    state.activeTabId = null
    hydrateWorktreeFromSync(snapshot(1, { '/Users/me/src/ion': [] }, {}), 'local')
    hydrateWorktreeFromSync(snapshot(1, { '/Users/r/src/api': [worktree] }, { '/Users/r/src/api': [bench] }), 'env-remote')
  })

  // A worktree verb names a path, not a tab. Sent to the local server, a
  // refresh of another machine's repository recorded an empty row there that
  // hid the remote's real worktrees, and a land or sync could not run at all.
  it('goes to the machine whose worktree read model holds the repository, worktree, or bench path', () => {
    expect(resolveActionEnvironment('refreshWorkspaceViews', ['/Users/r/src/api'])).toBe('env-remote')
    expect(resolveActionEnvironment('landAndRetireWorktree', ['/Users/r/src/api', {}])).toBe('env-remote')
    expect(resolveActionEnvironment('syncWorktree', [worktree.worktreePath, 'main', '/Users/r/src/api'])).toBe('env-remote')
    expect(resolveActionEnvironment('sealLandedWorktree', [worktree.worktreePath])).toBe('env-remote')
    expect(resolveActionEnvironment('benchRerereDiscardAll', [bench.benchPath])).toBe('env-remote')
    expect(resolveActionEnvironment('refreshWorkspaceViews', ['/Users/me/src/ion'])).toBe('local')
  })

  it('a path no machine has published stays local, and an explicit target still wins', () => {
    expect(resolveActionEnvironment('refreshWorkspaceViews', ['/nowhere'])).toBe('local')
    expect(withTargetEnvironment('env-other', () => resolveActionEnvironment('refreshWorkspaceViews', ['/Users/r/src/api']))).toBe('env-other')
  })
})
