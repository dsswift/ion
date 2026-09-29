/**
 * The active conversation's workspace roots: its checkout first, then the
 * project's added workspace folders, deduped. The Explorer lists these and
 * Workspace Search searches them, so both read this one hook.
 */
import { useMemo } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { orderedWorkspaceRoots } from '@ion/shared/workspace-roots'
import { useWorkspaceFolders } from './useWorkspaceFolders'
import { useProjectDir } from './useProjectDir'

export function useWorkspaceRoots(): {
  workingDir: string | null
  projectDir: string | null
  roots: ReturnType<typeof orderedWorkspaceRoots>
  /** Primary first, then secondaries; empty without a working directory. */
  allRoots: string[]
  folders: ReturnType<typeof useWorkspaceFolders>
} {
  const activeTab = useSessionStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const workingDir = activeTab?.workingDirectory || null
  const projectDir = useProjectDir(workingDir, activeTab?.worktree)
  const folders = useWorkspaceFolders()
  const roots = useMemo(() => orderedWorkspaceRoots(workingDir, projectDir, folders.folders), [workingDir, projectDir, folders.folders])
  const allRoots = useMemo(() => (roots.primary ? [roots.primary, ...roots.secondary] : []), [roots])
  return { workingDir, projectDir, roots, allRoots, folders }
}
