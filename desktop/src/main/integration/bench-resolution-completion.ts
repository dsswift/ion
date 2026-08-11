import { probeOperationState } from '../git/operation-state'
import { runGit } from '../git-runner'
import { repositoryManager } from '../git/repositoryManager'
import { log as _log, warn as _warn } from '../logger'
import { loadWorkspaces, saveWorkspaces } from './bench-store'

const TAG = 'bench.resolution.complete'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Clear one member's recorded conflict after its resolve-once merge committed.
 *
 * The resolution commit records rerere state for a future assembly; it does not
 * assemble the bench. Therefore the member returns to `unbuilt`, while the
 * workspace keeps its failed assembly result and error until an explicit
 * assembly produces a new outcome.
 */
export function clearResolvedBenchConflict(directory: string, mergedSha: string): boolean {
  const workspaces = loadWorkspaces()
  const workspaceIndex = workspaces.findIndex((workspace) => workspace.benchPath === directory)
  if (workspaceIndex < 0) {
    log('resolved member conflict not cleared: bench workspace missing', { directory, merged_sha: mergedSha })
    return false
  }

  const workspace = workspaces[workspaceIndex]
  const memberIndex = workspace.members.findIndex((member) => (
    member.pinnedSha === mergedSha && member.merge === 'conflicted'
  ))
  if (memberIndex < 0) {
    log('resolved member conflict not cleared: matching conflicted member missing', {
      directory, merged_sha: mergedSha, members: workspace.members.length,
    })
    return false
  }

  const member = workspace.members[memberIndex]
  const members = workspace.members.map((candidate, index) => (
    index === memberIndex
      ? {
        ...candidate,
        merge: 'unbuilt' as const,
        conflictPaths: undefined,
        conflictsWith: undefined,
        mergeResolution: undefined,
        priorResolutions: undefined,
      }
      : candidate
  ))
  const persisted = [...workspaces]
  persisted[workspaceIndex] = { ...workspace, members }
  if (!saveWorkspaces(persisted)) {
    warn('resolved member conflict state could not be persisted', {
      directory, merged_sha: mergedSha, branch: member.branchName,
    })
    return false
  }
  log('resolved member conflict state cleared', {
    directory,
    merged_sha: mergedSha,
    branch: member.branchName,
    merge: 'unbuilt',
    assembly: workspace.lastAssembly ?? 'unknown',
  })
  return true
}

/**
 * Confirm that an auto-fix completed the merge it was asked to resolve.
 *
 * A normal model completion is not proof: the checkout must have no operation
 * in progress, and HEAD must be a merge commit whose second parent is exactly a
 * member pin still recorded as conflicted. Git's parent identity is precise and
 * prevents an unrelated old merge from clearing a live row badge.
 */
export async function reconcileCompletedBenchResolution(directory: string): Promise<boolean> {
  const workspace = loadWorkspaces().find((candidate) => candidate.benchPath === directory)
  if (!workspace) {
    log('auto-fix resolution reconciliation skipped: directory is not a bench', { directory })
    return false
  }

  return repositoryManager.get(workspace.repoPath).queue.enqueueMutation(
    () => reconcileCompletedBenchResolutionUnqueued(directory),
  )
}

async function reconcileCompletedBenchResolutionUnqueued(directory: string): Promise<boolean> {
  try {
    const operation = await probeOperationState(directory)
    if (operation.state) {
      log('auto-fix resolution reconciliation skipped: operation remains open', {
        directory, operation: operation.state, unmerged_paths: operation.conflictedPaths.length,
      })
      return false
    }

    const mergedSha = (await runGit(directory, ['rev-parse', 'HEAD^2'])).trim()
    if (!mergedSha) {
      log('auto-fix resolution reconciliation skipped: head has no merge parent', { directory })
      return false
    }
    return clearResolvedBenchConflict(directory, mergedSha)
  } catch (err) {
    warn('auto-fix resolution reconciliation could not verify completed merge', {
      directory, error: String(err),
    })
    return false
  }
}
