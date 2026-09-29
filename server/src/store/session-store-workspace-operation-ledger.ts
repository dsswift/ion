import type { StoreSet } from './session-store-types'
import type { WorkspaceOperation } from './session-store-worktree-sync'

let sequence = 0
const MAX_LEDGER_ENTRIES = 40

const WORKSPACE_MUTATION_ACTIONS = new Set([
  'syncWorktree', 'startWorktreePipeline', 'confirmWorktreePipelineAi',
  'landAndRetireWorktree', 'retireWorktree',
  'benchAssemble', 'benchResolveConflict', 'benchDiscardMemberRecordings',
  'benchUpdateMember', 'benchUpdateAll', 'benchAddMember', 'benchRemoveMember',
  'benchSetOrder', 'continueConflictOperation', 'abortConflictOperation',
])

function descriptor(action: string, args: unknown[]): Pick<WorkspaceOperation,
  'repoPath' | 'sourceBranch' | 'worktreePath' | 'benchPath'> {
  const repoPath = typeof args[0] === 'string' ? args[0] : undefined
  if (action === 'syncWorktree') {
    return {
      worktreePath: typeof args[0] === 'string' ? args[0] : undefined,
      sourceBranch: typeof args[1] === 'string' ? args[1] : undefined,
      repoPath: typeof args[2] === 'string' ? args[2] : undefined,
    }
  }
  // landAndRetireWorktree(repoPath, entry, strategyOverride?): the worktree it
  // acts on is carried on the entry object, not as a positional string. The row
  // menu's busy guard matches this ledger entry by worktreePath, so extracting
  // it here is what makes the confirm dialog show its spinner and lock its
  // buttons for the whole land+retire, rather than staying inert.
  if (action === 'landAndRetireWorktree') {
    const entry = args[1] as { worktreePath?: string; sourceBranch?: string } | undefined
    return {
      repoPath,
      worktreePath: typeof entry?.worktreePath === 'string' ? entry.worktreePath : undefined,
      sourceBranch: typeof entry?.sourceBranch === 'string' ? entry.sourceBranch : undefined,
    }
  }
  // retireWorktree(repoPath, worktreePath, branchName): worktreePath is the
  // SECOND arg, so the generic tail below (which reads args[2]) would record the
  // branch name instead and the busy guard would never match.
  if (action === 'retireWorktree') {
    return { repoPath, worktreePath: typeof args[1] === 'string' ? args[1] : undefined }
  }
  if (action === 'continueConflictOperation' || action === 'abortConflictOperation') {
    return { worktreePath: typeof args[0] === 'string' ? args[0] : undefined }
  }
  const sourceBranch = typeof args[1] === 'string' ? args[1] : undefined
  const worktreePath = typeof args[2] === 'string' ? args[2] : undefined
  return { repoPath, sourceBranch, worktreePath }
}

function terminalStatus(result: unknown): 'succeeded' | 'failed' {
  return result && typeof result === 'object' && 'ok' in result && (result as { ok?: unknown }).ok === false
    ? 'failed'
    : 'succeeded'
}

function terminalMessage(result: unknown): string | undefined {
  return result && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string'
    ? (result as { error: string }).error
    : undefined
}

/** Add owner-visible lifecycle entries around the workspace mutations Studio renders. */
export function trackWorkspaceActions<T extends Record<string, unknown>>(
  set: StoreSet,
  actions: T,
): T {
  return Object.fromEntries(Object.entries(actions).map(([action, value]) => {
    if (!WORKSPACE_MUTATION_ACTIONS.has(action) || typeof value !== 'function') return [action, value]
    return [action, async (...args: unknown[]) => {
      const id = `${action}:${++sequence}`
      const running: WorkspaceOperation = {
        id,
        action,
        status: 'running',
        startedAt: Date.now(),
        ...descriptor(action, args),
      }
      set((state) => ({
        workspaceOperationLedger: new Map(state.workspaceOperationLedger).set(id, running),
      }))
      try {
        const result = await (value as (...parameters: unknown[]) => unknown)(...args)
        const status = terminalStatus(result)
        const complete: WorkspaceOperation = {
          ...running,
          status,
          completedAt: Date.now(),
          error: terminalMessage(result),
        }
        set((state) => ({ workspaceOperationLedger: bounded(state.workspaceOperationLedger, complete) }))
        return result
      } catch (error) {
        const complete: WorkspaceOperation = {
          ...running,
          status: 'failed',
          completedAt: Date.now(),
          error: error instanceof Error ? error.message : String(error),
        }
        set((state) => ({ workspaceOperationLedger: bounded(state.workspaceOperationLedger, complete) }))
        throw error
      }
    }]
  })) as T
}

function bounded(current: Map<string, WorkspaceOperation>, complete: WorkspaceOperation): Map<string, WorkspaceOperation> {
  const next = new Map(current)
  next.set(complete.id, complete)
  while (next.size > MAX_LEDGER_ENTRIES) next.delete(next.keys().next().value as string)
  return next
}
