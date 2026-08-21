import type { PersistedTab } from '../../shared/types'
import { useSessionStore } from '../stores/sessionStore'
import { reportStartup } from '../startup-report'
import { startRestoredSessions } from './useTabRestoration-sessions'
import type { RestoredTabRef } from './useTabRestoration-helpers'

function reportRestorePhase(status: string): void {
  useSessionStore.setState({ initProgress: status })
  reportStartup('owner', status)
}

/** Report exact restored-session attach progress to the startup splash. */
export function reportRestoredSessionAttachProgress(completed: number, total: number): void {
  reportRestorePhase(`Starting restored sessions ${completed} of ${total}…`)
}

export function reportRestoreHistoryLoading(): void {
  reportRestorePhase('Loading conversation history…')
}

export function reportRestoreActiveConversation(): void {
  reportRestorePhase('Preparing active conversation…')
}

export function reportRestoreWorkspaceState(): void {
  reportRestorePhase('Loading workspace state…')
}

export function reportRestoreLayout(): void {
  reportRestorePhase('Restoring workspace layout…')
}

/** Start restored sessions and surface each exact attach completion on the splash. */
export function startRestoredSessionsWithSplashProgress(
  restoredTabIds: RestoredTabRef[],
  savedTabs: PersistedTab[],
  activeTabIndex: number,
  worktreeAliveByIndex: Map<number, boolean>,
  persistedTabHasExtensions: (tab: PersistedTab) => boolean,
): Promise<void> {
  return startRestoredSessions(
    restoredTabIds,
    savedTabs,
    activeTabIndex,
    worktreeAliveByIndex,
    persistedTabHasExtensions,
    reportRestoredSessionAttachProgress,
  )
}
