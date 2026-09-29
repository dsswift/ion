/**
 * Resolve integration-bench mutations onto the source repository's queue.
 *
 * Bench git state lives in a linked worktree, but assembly, conflict preparation,
 * and operator resolution all mutate one repository. They must therefore share
 * the queue keyed by the workspace's canonical repoPath, not separate queues
 * keyed by each worktree path.
 *
 * This helper only selects and enters the queue. Callbacks must perform their
 * unqueued git operation directly. Enqueuing again from inside the callback
 * would wait on itself forever.
 */
import type { OperationQueue } from '../git/operationQueue'
import { repositoryManager } from '../git/repositoryManager'
import { resolveBenchFor } from './bench-guard'
import { loadWorkspaces } from './bench-store'

/** Return the shared source-repository queue for a bench directory. */
export function benchMutationQueue(directory: string): OperationQueue | null {
  const benchPath = resolveBenchFor(directory)
  if (!benchPath) return null

  const workspace = loadWorkspaces().find((candidate) => candidate.benchPath === benchPath)
  if (!workspace) return null

  return repositoryManager.get(workspace.repoPath).queue
}
