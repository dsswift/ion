/**
 * useProjectDir — the Project that owns a directory, live from the stores.
 *
 * The one hook both the explorer and the git panel call, so neither can key a
 * per-Project setting by anything but the Project. Subscribes to the raw store
 * maps (stable references) and flattens them in a memo, so a re-render happens
 * only when the worktree inventory, the bench list, or the Project registry
 * actually changes.
 */
import { useMemo } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { selectProjectResolutionSources } from '../stores/project-workspace-sources'
import { resolveProjectDir } from '../../shared/project-workspace'

export function useProjectDir(
  directory: string | null | undefined,
  worktree: { repoPath?: string | null } | null | undefined,
): string | null {
  const worktreeInventory = useSessionStore((s) => s.worktreeInventory)
  const benchWorkspaces = useSessionStore((s) => s.benchWorkspaces)
  const projects = usePreferencesStore((s) => s.projects)
  const sources = useMemo(
    () => selectProjectResolutionSources({ worktreeInventory, benchWorkspaces }, { projects }),
    [worktreeInventory, benchWorkspaces, projects],
  )
  return useMemo(() => resolveProjectDir(directory, worktree, sources), [directory, worktree, sources])
}
