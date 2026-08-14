import type { WorktreeInfo } from '../../shared/types'
import { rDebug, rInfo, rWarn } from '../rendererLogger'

/**
 * Resolve authoritative managed-worktree identity for a tab directory.
 *
 * Tab state must carry this record before it renders. GitPanel uses repoPath to
 * select inventory and bench caches synchronously; adding metadata after render
 * briefly presents a complete but false workbench. Existing metadata wins
 * because it was already captured when the worktree was created. Missing
 * metadata is repaired from the registry, never from path shape or display
 * caches.
 */
export async function resolveRegisteredWorktree(
  workingDirectory: string,
  existing?: WorktreeInfo | null,
): Promise<WorktreeInfo | null> {
  if (existing) {
    rDebug('worktree.registration', 'using existing tab worktree metadata', {
      worktree_path: existing.worktreePath,
      repo_path: existing.repoPath,
    })
    return existing
  }

  try {
    const { registration } = await window.ion.gitWorktreeRegistration(workingDirectory)
    if (!registration) {
      rDebug('worktree.registration', 'directory is not a registered worktree', {
        worktree_path: workingDirectory,
      })
      return null
    }
    if (!registration.sourceBranch) {
      rWarn('worktree.registration', 'registered worktree has no source branch', {
        worktree_path: workingDirectory,
        repo_path: registration.repoPath,
        branch: registration.branchName,
      })
      return null
    }

    const worktree: WorktreeInfo = {
      worktreePath: workingDirectory,
      branchName: registration.branchName,
      sourceBranch: registration.sourceBranch,
      repoPath: registration.repoPath,
      landedAt: registration.landedAt ?? undefined,
    }
    rInfo('worktree.registration', 'resolved tab worktree metadata from registry', {
      worktree_path: workingDirectory,
      repo_path: registration.repoPath,
      branch: registration.branchName,
      source_branch: registration.sourceBranch,
    })
    return worktree
  } catch (err) {
    rWarn('worktree.registration', 'worktree registration lookup failed', {
      worktree_path: workingDirectory,
      error: String(err),
    })
    return null
  }
}
