import type { SurfaceConversationPersisted } from '../../../shared/studio-surface-types'
import { useSessionStore } from '../../stores/sessionStore'
import { editorDirForTab } from '../../stores/session-store-helpers'
import { rDebug, rWarn } from '../../rendererLogger'
import type { SurfaceTab } from '../../../shared/studio-surface-types'
import { runtimePanel, unregisterRuntimePanel } from './runtime-panel-registry'

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
