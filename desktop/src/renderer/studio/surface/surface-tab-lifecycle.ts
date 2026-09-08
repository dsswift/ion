import type { SurfaceConversationPersisted } from '../../../shared/studio-surface-types'
import { useSessionStore } from '../../stores/sessionStore'
import { editorDirForTab } from '../../stores/session-store-helpers'
import { rDebug, rWarn } from '../../rendererLogger'
import type { SurfaceTab } from '../../../shared/studio-surface-types'
import { runtimePanel, unregisterRuntimePanel } from './runtime-panel-registry'
import { useGraphStore } from '../graph/graph-store'
import { useSurfaceStore } from './surface-store'
import { forgetAnchorIfGone } from './editor-anchor'

export function materializeFileBuffer(filePath: string, dir: string, tabId: string | undefined): string | null {
  const sessionState = useSessionStore.getState()
  if (tabId) {
    const tab = sessionState.tabs.find((item) => item.id === tabId)
    if (!tab) {
      rWarn('studio.surface', 'materializeFileBuffer: source tab gone, skipping', { tab_id: tabId, file_path: filePath })
      return null
    }
    const resolvedDir = editorDirForTab(tab)
    sessionState.openFileInEditor(resolvedDir, tabId, filePath)
    return resolvedDir
  }
  sessionState.openFileInEditor(dir, '', filePath)
  return dir
}

export function materializeConversation(conversation: SurfaceConversationPersisted): SurfaceConversationPersisted {
  const tabs: SurfaceTab[] = []
  for (const tab of conversation.tabs) {
    if (tab.kind !== 'file') {
      tabs.push(tab)
      continue
    }
    const dir = materializeFileBuffer(tab.filePath, tab.dir, tab.tabId)
    if (dir !== null) tabs.push({ ...tab, dir })
  }
  return { ...conversation, tabs }
}

export function teardownSurfaceTab(tab: SurfaceTab, conversationId: string | null): void {
  if (tab.kind === 'file' && conversationId) {
    // The anchor points at a path, so it must not outlive the last tab
    // showing it: a graph opened afterwards would anchor on a document the
    // operator already closed. Reopening the same file records it again.
    const remaining = useSurfaceStore.getState().tabs.filter((t) => t.id !== tab.id)
    forgetAnchorIfGone(conversationId, remaining)
  }
  if (tab.kind === 'singleton' && tab.id === 'graph' && conversationId) {
    // A graph session is keyed by directory and shared by every
    // conversation open on it, so closing one conversation's graph tab
    // releases the session only when no other conversation still has one
    // open on that same directory. Releasing unconditionally would drop a
    // sibling conversation's live graph and its corpus subscription.
    const sessionState = useSessionStore.getState()
    const closing = sessionState.tabs.find((item) => item.id === conversationId)
    const directory = closing?.workingDirectory ?? null
    if (directory) {
      const surface = useSurfaceStore.getState()
      const stillOpen = Object.entries(surface.conversations).some(([id, conversation]) => {
        if (id === conversationId) return false
        if (!conversation.tabs.some((t) => t.kind === 'singleton' && t.id === 'graph')) return false
        const other = sessionState.tabs.find((item) => item.id === id)
        return (other?.workingDirectory ?? null) === directory
      })
      if (stillOpen) {
        rDebug('studio.surface', 'graph tab closed, session kept for sibling conversation', { directory })
      } else {
        useGraphStore.getState().closeSession(directory)
        rDebug('studio.surface', 'graph tab closed, session released', { directory })
      }
    }
  }
  if (tab.kind === 'browser' && conversationId) {
    void window.ion.studioBrowserViewClose(conversationId, tab.instanceId)
      .catch((err) => rWarn('studio.surface', 'browser view close failed', { instance_id: tab.instanceId, error: String(err) }))
    rDebug('studio.surface', 'browser tab closed, view destroyed', { instance_id: tab.instanceId })
  }
  if (tab.kind === 'terminal') {
    void window.ion.terminalDestroy?.(`${conversationId ?? 'studio'}:surface:${tab.instanceId}`)
    rDebug('studio.surface', 'terminal tab closed, pty destroyed', { instance_id: tab.instanceId })
  }
  if (tab.kind === 'runtime-panel') {
    const entry = runtimePanel(tab.id)
    unregisterRuntimePanel(tab.id)
    entry?.close()
  }
}
