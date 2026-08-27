import type { ResourceItem } from '../../../shared/types-engine'
import { registerContentRouter } from '../../lib/file-open-router'
import { useSurfaceStore } from './surface-store'
import { useSessionStore } from '../../stores/sessionStore'
import { activeInstance } from '../../stores/conversation-instance'
import { latestPlanPathFromMessages } from '../../components/StatusBarAttachmentsParser'
import { registerRuntimePanel, updateRuntimePanel } from './runtime-panel-registry'
import { rDebug, rTrace, rWarn } from '../../rendererLogger'

export function registerStudioFileRouter(revealSurface: () => void = () => {}): void {
  registerContentRouter({
    openTextFile: (dir, tabId, filePath) => {
      revealSurface()
      useSurfaceStore.getState().openFileTab(dir, tabId, filePath)
    },
    openPlan: (dir, tabId, filePath) => {
      revealSurface()
      const session = useSessionStore.getState()
      const instance = activeInstance(session.conversationPanes, tabId)
      const latestPlanPath = latestPlanPathFromMessages(
        instance?.messages ?? [],
        instance?.planFilePath ?? null,
      )
      if (latestPlanPath === filePath) {
        useSurfaceStore.getState().openSingleton('plan')
        rDebug('studio.plan', 'opened latest plan in canvas', { tab_id: tabId, path: filePath })
        return
      }
      useSurfaceStore.getState().openFileTab(dir, tabId, filePath)
      rDebug('studio.plan', 'opened historical plan in file tab', {
        tab_id: tabId,
        path: filePath,
        latest_plan_path: latestPlanPath ?? '',
      })
    },
    openImage: (filePath, dataUrl) => {
      revealSurface()
      useSurfaceStore.getState().openPreviewTab(filePath, dataUrl)
    },
    openHtml: (filePath) => {
      revealSurface()
      useSurfaceStore.getState().openBrowserTab(`file://${filePath}`, 'preview')
    },
    openUrl: (url) => {
      // A NEW tab per click, deliberately. Reusing one tab would make each
      // ⌘-click destroy the page from the previous one, and following a few
      // links out of a transcript is exactly when the operator wants to keep
      // the earlier pages around to compare.
      //
      // 'browse' mode, not 'preview': a preview tab carries the offline
      // network shield, which would leave a link the operator explicitly
      // opened unable to load.
      revealSurface()
      useSurfaceStore.getState().openBrowserTab(url, 'browse')
      rDebug('studio.surface', 'opened clicked link in browser tab', { host: hostOf(url) })
      return true
    },
    openWebApplication: (tabId, url) => {
      revealSurface()
      useSessionStore.getState().selectTab(tabId)
      useSurfaceStore.getState().openBrowserTab(url, 'browse')
    },
    openGitDiff: ({ repoDir, filePath, staged }) => {
      const session = useSessionStore.getState()
      const activeDirectory = session.tabs.find((tab) => tab.id === session.activeTabId)?.workingDirectory
      if (repoDir !== activeDirectory) {
        rDebug('studio.diff', 'declined workspace diff reveal outside active checkout', {
          active_directory: activeDirectory ?? '',
          file_path: filePath,
          repo_directory: repoDir,
        })
        return false
      }
      revealSurface()
      useSurfaceStore.getState().revealDiffFile({ filePath, staged })
      rDebug('studio.diff', 'revealed active checkout diff', { directory: repoDir, file_path: filePath, staged })
      return true
    },
    openResource: (item: ResourceItem) => {
      revealSurface()
      useSurfaceStore.getState().openResourceTab(item)
    },
    openStatus: () => {
      revealSurface()
      useSurfaceStore.getState().openSingleton('status')
    },
    openExplorer: () => {
      revealSurface()
      useSurfaceStore.getState().openSingleton('files')
    },
    openGitPanel: () => {
      revealSurface()
      useSurfaceStore.getState().openSingleton('gitpanel')
    },
    openDispatch: (agentName, dispatchId, title) => {
      revealSurface()
      useSurfaceStore.getState().openDispatchTab(agentName, dispatchId, title)
      rDebug('studio.surface', 'dispatch preview opened', {
        agent: agentName,
        dispatch_id: dispatchId,
        tab_id: useSessionStore.getState().activeTabId,
      })
    },
    openPanel: (title, body, close) => {
      revealSurface()
      const id = registerRuntimePanel({ title, body, close })
      useSurfaceStore.getState().openRuntimePanel(id, title)
      rDebug('studio.runtime-panel', 'registered routed panel', { panel_id: id, title })
      return id
    },
    updatePanel: (id, title, body) => {
      if (!updateRuntimePanel(id, { title, body })) {
        rWarn('studio.runtime-panel', 'ignored update for missing routed panel', { panel_id: id, title })
        return
      }
      useSurfaceStore.getState().updateRuntimePanelTitle(id, title)
      rTrace('studio.runtime-panel', 'updated routed panel content', { panel_id: id, title })
    },
    closePanel: (id) => {
      useSurfaceStore.getState().removeRuntimePanel(id)
      rDebug('studio.runtime-panel', 'released routed panel', { panel_id: id })
    },
  })
}

/** Host only: a full URL in a log line can carry tokens in its query. */
function hostOf(raw: string): string {
  try {
    return new URL(raw).host
  } catch {
    return ''
  }
}
