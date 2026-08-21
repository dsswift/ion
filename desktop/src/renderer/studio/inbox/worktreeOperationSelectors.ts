import { useSessionStore } from '../../stores/sessionStore'

type Operation = {
  action: string
  kind?: string
  status: 'running' | 'succeeded' | 'failed'
  repoPath?: string
  sourceBranch?: string
  worktreePath?: string
  benchPath?: string
  error?: string
}

type WorktreePipeline = {
  repoPath: string
  phase: 'syncing' | 'awaiting-ai-confirm' | 'resolving' | 'assembling' | 'done' | 'failed'
}

type LedgerState = {
  workspaceOperationLedger?: Map<string, Operation>
  worktreeOperations?: Map<string, Operation>
}

function ledgerOf(state: LedgerState): Map<string, Operation> {
  return state.workspaceOperationLedger ?? state.worktreeOperations ?? new Map()
}

function isPending(operation: Operation | undefined): boolean {
  return operation?.status === 'running'
}

export function useWorktreeOperation(worktreePath: string): Operation | undefined {
  return useSessionStore((state) => {
    const ledger = ledgerOf(state)
    const operation = [...ledger.values()]
      .find((candidate) => candidate.worktreePath === worktreePath && isPending(candidate))
    return operation ? { ...operation, kind: operation.kind ?? operation.action } : undefined
  })
}

export function useBenchOperation(repoPath: string, sourceBranch: string | undefined): Operation | undefined {
  return useSessionStore((state) => {
    const ledger = ledgerOf(state)
    const operation = [...ledger.values()]
      .find((candidate) => isPending(candidate) && candidate.repoPath === repoPath &&
        (candidate.sourceBranch === sourceBranch || candidate.action === 'startWorktreePipeline'))
    return operation ? { ...operation, kind: operation.kind ?? operation.action } : undefined
  })
}

export function useWorktreePipeline(repoPath: string): WorktreePipeline | null {
  return useSessionStore((state) => state.worktreePipeline?.repoPath === repoPath
    ? state.worktreePipeline
    : null)
}

export function operationIsPending(operation: Operation | undefined): boolean {
  return isPending(operation)
}

export function operationMessage(operation: Operation | undefined): string | undefined {
  return operation?.error
}

export function pipelineIsRunning(pipeline: WorktreePipeline | null): boolean {
  return pipeline !== null && pipeline.phase !== 'done' && pipeline.phase !== 'failed'
}
