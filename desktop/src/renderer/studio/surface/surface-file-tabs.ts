/**
 * Pure conversation transforms for file and preview tabs.
 *
 * Split out of `surface-store.ts` so that file stays under its size cap. Both
 * preserve `agentBrowserInstanceId` through `normalizeTabs`: opening a file
 * must never disturb which browser tab the agent is linked to.
 */
import { fileTabId, previewTabId, type SurfaceConversationPersisted } from '../../../shared/studio-surface-types'
import { normalizeTabs } from '../../../shared/studio-surface-ordering'

/** Open a file tab, or focus it when already present. */
export function openFileTabIn(
  current: SurfaceConversationPersisted,
  filePath: string,
  dir: string,
  tabId: string,
): SurfaceConversationPersisted {
  const id = fileTabId(filePath)
  if (current.tabs.some((tab) => tab.id === id)) return { ...current, activeTabId: id }
  return {
    ...current,
    tabs: normalizeTabs([...current.tabs, { kind: 'file', id, filePath, dir, tabId }], current.agentBrowserInstanceId),
    activeTabId: id,
  }
}

/** Open an image/preview tab, refreshing its data URL when it already exists. */
export function openPreviewTabIn(
  current: SurfaceConversationPersisted,
  filePath: string,
  dataUrl: string | undefined,
): SurfaceConversationPersisted {
  const id = previewTabId(filePath)
  const old = current.tabs.find((tab) => tab.id === id)
  const tabs = old?.kind === 'preview'
    ? current.tabs.map((tab) => (tab.id === id ? { ...old, dataUrl: dataUrl ?? old.dataUrl } : tab))
    : normalizeTabs([...current.tabs, { kind: 'preview', id, filePath, dataUrl }], current.agentBrowserInstanceId)
  return { ...current, tabs, activeTabId: id }
}
