/**
 * The one selector that flattens the session store's worktree and bench caches
 * plus the preferences Project registry into the plain shape
 * `resolveProjectDir` consumes. Both explorer and git panel call it, so the two
 * surfaces resolve the same Project for the same directory by construction.
 */
import type { ProjectResolutionSources } from '../../shared/project-workspace'
import type { State } from './session-store-types'
import type { PreferencesState } from '../preferences-types'

export function selectProjectResolutionSources(
  session: Pick<State, 'worktreeInventory' | 'benchWorkspaces'>,
  preferences: Pick<PreferencesState, 'projects'>,
): ProjectResolutionSources {
  const worktrees: ProjectResolutionSources['worktrees'] = []
  for (const [repoPath, entries] of session.worktreeInventory) {
    for (const entry of entries) worktrees.push({ worktreePath: entry.worktreePath, repoPath })
  }
  const benches: ProjectResolutionSources['benches'] = []
  for (const [repoPath, workspaces] of session.benchWorkspaces) {
    for (const workspace of workspaces) benches.push({ benchPath: workspace.benchPath, repoPath })
  }
  return { worktrees, benches, projects: Object.keys(preferences.projects ?? {}) }
}
