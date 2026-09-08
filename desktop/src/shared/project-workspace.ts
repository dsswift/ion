/**
 * project-workspace — "which Project does this directory belong to?"
 *
 * A Project is a workspace: one source directory plus zero or more mounted
 * folders. A worktree and a bench are branch checkouts INSIDE a Project's
 * repository, not workspaces of their own, so both inherit that Project's
 * mounted folders. A Project with no git repo has neither, and mounts folders
 * the same way.
 *
 * Every surface that reads or writes a per-Project setting resolves its key
 * through this one function. Keying by the active tab's directory instead is
 * what made a worktree tab see none of its Project's mounted folders.
 *
 * Pure string logic over data the caller already holds: no store import, no
 * filesystem, no `node:path`. Containment is `isWithinRepo`, never a substring
 * test — see repo-containment.ts for the sibling-prefix bug that rule exists
 * to kill.
 */
import { isAbsolutePath } from './paths'
import { isWithinRepo } from './repo-containment'
import { normalizeWorkspacePath } from './workspace-roots'

/** One registered worktree: where it lives, and the repo it was cut from. */
export interface ProjectWorktreeSource {
  worktreePath: string
  repoPath: string
}

/** One integration bench: where it lives, and the repo it assembles. */
export interface ProjectBenchSource {
  benchPath: string
  repoPath: string
}

/**
 * Everything resolution needs, as plain arrays. The renderer builds this from
 * the session and preferences stores; a test builds it by hand.
 */
export interface ProjectResolutionSources {
  worktrees: ProjectWorktreeSource[]
  benches: ProjectBenchSource[]
  /** Registered Project directories (`preferences.projects` keys). */
  projects: string[]
}

/**
 * The Project directory that owns `directory`.
 *
 * Resolution order, first match wins:
 *
 * 1. `worktree.repoPath` — the tab's own registered worktree metadata, the
 *    most direct statement of which repo this checkout belongs to.
 * 2. A registered worktree that contains the directory (covers a subdirectory
 *    of a worktree, and a tab whose metadata has not loaded).
 * 3. A bench that contains the directory.
 * 4. The longest registered Project that contains it — longest so a Project
 *    nested inside another resolves to the inner one.
 * 5. The directory itself: an unregistered ad-hoc conversation is its own
 *    workspace, which is the behaviour every surface had before Projects.
 */
export function resolveProjectDir(
  directory: string | null | undefined,
  worktree: { repoPath?: string | null } | null | undefined,
  sources: ProjectResolutionSources,
): string | null {
  if (worktree?.repoPath) return normalizeWorkspacePath(worktree.repoPath)
  if (!directory) return null
  const dir = normalizeWorkspacePath(directory)
  // A relative or placeholder value ('~') cannot be matched against a repo
  // root, so it is returned as-is. Absolute must include the Windows forms, or
  // every Windows conversation returned here and skipped worktree and bench
  // resolution entirely.
  if (!isAbsolutePath(dir)) return dir

  for (const wt of sources.worktrees) {
    if (wt.repoPath && isWithinRepo(dir, normalizeWorkspacePath(wt.worktreePath))) {
      return normalizeWorkspacePath(wt.repoPath)
    }
  }
  for (const bench of sources.benches) {
    if (bench.repoPath && isWithinRepo(dir, normalizeWorkspacePath(bench.benchPath))) {
      return normalizeWorkspacePath(bench.repoPath)
    }
  }

  let best: string | null = null
  for (const project of sources.projects) {
    const root = normalizeWorkspacePath(project)
    if (!isWithinRepo(dir, root)) continue
    if (best === null || root.length > best.length) best = root
  }
  return best ?? dir
}

/** Sources with nothing registered — the resolver then answers `directory`. */
export const EMPTY_PROJECT_SOURCES: ProjectResolutionSources = { worktrees: [], benches: [], projects: [] }
