/**
 * trackWorkspaceActions — land and retire feed the operation ledger.
 *
 * The worktree row menu's confirm dialog raises its busy state (spinner shown,
 * buttons locked) only while a `running` ledger entry matches the worktree it
 * acts on. Land and retire used to be absent from the tracked set, so the
 * dialog never went busy and the operator could still click Keep it / Land and
 * retire while the operation was already in flight.
 *
 * Regression direction: dropping `landAndRetireWorktree` / `retireWorktree`
 * from WORKSPACE_MUTATION_ACTIONS leaves the action unwrapped, so no ledger
 * entry appears and the length assertions go red. Removing their descriptor
 * branches records the wrong worktreePath (a strategy string, or the branch
 * name), so the busy guard would never match and those assertions go red.
 */
import { describe, it, expect } from 'vitest'
import { trackWorkspaceActions } from './session-store-workspace-operation-ledger'
import type { WorkspaceOperation } from './session-store-worktree-sync'

function harness(): {
  state: { workspaceOperationLedger: Map<string, WorkspaceOperation> }
  set: Parameters<typeof trackWorkspaceActions>[0]
} {
  const state = { workspaceOperationLedger: new Map<string, WorkspaceOperation>() }
  const set = ((updater: unknown) => {
    const patch = typeof updater === 'function'
      ? (updater as (s: typeof state) => Partial<typeof state>)(state)
      : (updater as Partial<typeof state>)
    Object.assign(state, patch)
  }) as unknown as Parameters<typeof trackWorkspaceActions>[0]
  return { state, set }
}

describe('trackWorkspaceActions — land and retire', () => {
  it('records a running land+retire entry keyed by the entry worktreePath', async () => {
    const { state, set } = harness()
    let release!: () => void
    const gate = new Promise<{ ok: true }>((resolve) => {
      release = () => resolve({ ok: true })
    })
    const wrapped = trackWorkspaceActions(set, {
      landAndRetireWorktree: (
        _repoPath: string,
        _entry: { worktreePath: string; branchName: string; sourceBranch: string },
      ) => gate,
    })

    const call = wrapped.landAndRetireWorktree('/repo', {
      worktreePath: '/repo/wt',
      branchName: 'wt/work',
      sourceBranch: 'main',
    })

    // Set synchronously, before the inner action resolves: this is the window
    // during which the dialog must read as busy.
    const running = [...state.workspaceOperationLedger.values()]
    expect(running).toHaveLength(1)
    expect(running[0].status).toBe('running')
    expect(running[0].worktreePath).toBe('/repo/wt')
    expect(running[0].sourceBranch).toBe('main')

    release()
    await call
    const done = [...state.workspaceOperationLedger.values()]
    expect(done[0].status).toBe('succeeded')
  })

  it('records retireWorktree keyed by its second positional worktreePath arg', async () => {
    const { state, set } = harness()
    const wrapped = trackWorkspaceActions(set, {
      retireWorktree: async (_repoPath: string, _worktreePath: string, _branchName: string) => ({ ok: true }),
    })

    await wrapped.retireWorktree('/repo', '/repo/wt', 'wt/work')

    const entries = [...state.workspaceOperationLedger.values()]
    expect(entries).toHaveLength(1)
    expect(entries[0].worktreePath).toBe('/repo/wt')
    expect(entries[0].status).toBe('succeeded')
  })
})
