import type { WorktreeInfo } from '../../shared/types'

interface ProjectTab {
  workingDirectory: string
  worktree?: Pick<WorktreeInfo, 'repoPath'> | null
}

interface ProjectIdentityApi {
  gitWorktreeRegistration(path: string): Promise<{ registration: { repoPath: string } | null }>
  benchResolvePath(path: string): Promise<{ workspace: { repoPath: string } | null }>
}

/**
 * Resolve one conversation directory to its project root. Metadata is the fast
 * path; registry and bench IPC repair legacy tabs whose persisted metadata was
 * missing when they were restored.
 */
export async function resolveProjectIdentity(tab: ProjectTab, api: ProjectIdentityApi): Promise<string | null> {
  if (tab.worktree?.repoPath) return tab.worktree.repoPath
  const directory = tab.workingDirectory
  if (!directory || directory === '~') return null

  const [worktree, bench] = await Promise.all([
    api.gitWorktreeRegistration(directory),
    api.benchResolvePath(directory),
  ])
  return worktree.registration?.repoPath ?? bench.workspace?.repoPath ?? directory
}
