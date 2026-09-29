/**
 * useProjectStudioConfig — the active conversation's project config, read from
 * the Environment that hosts it and re-read when that Environment announces a
 * change (the file was edited, or its Quick Tools were trusted).
 *
 * The project directory is the base repository for a worktree conversation, so
 * every worktree of a project sees the project's committed config.
 */
import { useCallback, useEffect, useState } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { editorDirForTab } from '@ion/server/store/session-store-helpers'
import type { ProjectStudioConfigSnapshot } from '@ion/shared/project-studio-config'
import { host } from '../../host/host-instance'
import { rDebug, rWarn } from '../../rendererLogger'

export const NO_PROJECT_STUDIO_CONFIG: ProjectStudioConfigSnapshot = { root: null, quickTools: [], toolsHash: '', trusted: false }

export interface ProjectStudioConfigState {
  snapshot: ProjectStudioConfigSnapshot
  /** The directory the snapshot was read for; '' when there is no conversation. */
  directory: string
  reload: () => void
}

export function useProjectStudioConfig(): ProjectStudioConfigState {
  const directory = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab ? editorDirForTab(tab) : ''
  })
  const [snapshot, setSnapshot] = useState(NO_PROJECT_STUDIO_CONFIG)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!directory) { setSnapshot(NO_PROJECT_STUDIO_CONFIG); return }
    let cancelled = false
    host.shell.getProjectStudioConfig(directory)
      .then((next) => {
        if (cancelled) return
        rDebug('composer', 'project studio config read', { directory, tools: next.quickTools.length, trusted: next.trusted, refused: next.error ?? null })
        setSnapshot(next)
      })
      .catch((err) => {
        if (cancelled) return
        rWarn('composer', 'project studio config read failed', { directory, error: String(err) })
        setSnapshot(NO_PROJECT_STUDIO_CONFIG)
      })
    return () => { cancelled = true }
  }, [directory, tick])

  useEffect(() => host.shell.onProjectStudioConfigChanged(() => reload()), [reload])

  return { snapshot, directory, reload }
}
