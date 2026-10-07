/**
 * The Quick Tools that apply to the active conversation, split by where they
 * came from. `user` is the operator's own preference list; `project` is what
 * the conversation's project ships in its committed `.ion/studio.json`.
 */
import { isQuickToolList, useActiveServerSetting } from '../../studio/state/use-server-setting'
import { useMemo } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import type { QuickTool } from '@ion/shared/types'
import type { ProjectQuickTool } from '@ion/shared/project-studio-config'
import { visibleUserQuickTools } from '@ion/shared/quick-tools-visible'
import { useProjectStudioConfig } from './useProjectStudioConfig'

export interface ActiveQuickTools {
  user: QuickTool[]
  project: ProjectQuickTool[]
  /** Whether the operator has approved the current project tool list. */
  projectTrusted: boolean
  /** Identifies the project list the operator would be approving. */
  projectToolsHash: string
  /** The directory project actions are addressed to. */
  projectDirectory: string
}

export function useActiveQuickTools(): ActiveQuickTools {
  // A quick tool is a shell command the conversation's SERVER looks up by id
  // and runs, so the list offered is the one you keep on that server.
  const quickTools = useActiveServerSetting('quickTools', isQuickToolList, [])
  const workingDirectory = useSessionStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.workingDirectory ?? '',
  )
  const { snapshot, directory } = useProjectStudioConfig()
  return useMemo(
    () => ({
      user: visibleUserQuickTools(quickTools, workingDirectory),
      project: snapshot.quickTools,
      projectTrusted: snapshot.trusted,
      projectToolsHash: snapshot.toolsHash,
      projectDirectory: directory,
    }),
    [quickTools, workingDirectory, snapshot, directory],
  )
}
