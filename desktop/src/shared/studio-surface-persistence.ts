import {
  DEFAULT_PINNED_SURFACE_TABS,
  PINNABLE_SINGLETON_IDS,
  SINGLETON_ORDER,
  type LegacySurfacePersisted,
  type NotificationTab,
  type PinnableSingletonId,
  type SurfaceConversationPersisted,
  type SurfacePersisted,
  type SurfaceTab,
} from './studio-surface-types'
import { normalizeTabs } from './studio-surface-ordering'

const SINGLETONS = new Set<string>(SINGLETON_ORDER)
const PINNABLES = new Set<string>(PINNABLE_SINGLETON_IDS)

type ParsedSurface = SurfacePersisted | LegacySurfacePersisted

function parseTab(raw: unknown): SurfaceTab | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (v.kind === 'singleton') return typeof v.id === 'string' && SINGLETONS.has(v.id) ? { kind: 'singleton', id: v.id as SurfaceTab['id'] } as SurfaceTab : null
  if (v.kind === 'file') {
    if (typeof v.filePath !== 'string' || !v.filePath || typeof v.dir !== 'string') return null
    return { kind: 'file', id: `file:${v.filePath}`, filePath: v.filePath, dir: v.dir, ...(typeof v.tabId === 'string' && v.tabId ? { tabId: v.tabId } : {}) }
  }
  if (v.kind === 'preview') return typeof v.filePath === 'string' && v.filePath ? { kind: 'preview', id: `preview:${v.filePath}`, filePath: v.filePath } : null
  if (v.kind === 'browser') {
    if (typeof v.instanceId !== 'string' || !v.instanceId || typeof v.url !== 'string') return null
    return { kind: 'browser', id: `browser:${v.instanceId}`, instanceId: v.instanceId, url: v.url, title: typeof v.title === 'string' ? v.title : '', mode: v.mode === 'preview' ? 'preview' : 'browse' }
  }
  if (v.kind === 'terminal') {
    if (typeof v.instanceId !== 'string' || !v.instanceId || typeof v.cwd !== 'string') return null
    return { kind: 'terminal', id: `terminal:${v.instanceId}`, instanceId: v.instanceId, cwd: v.cwd, title: typeof v.title === 'string' && v.title ? v.title : 'Terminal 1' }
  }
  return null
}

function parseNotification(raw: unknown): NotificationTab | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (v.kind !== 'notification' || typeof v.resourceKind !== 'string' || !v.resourceKind || typeof v.resourceId !== 'string' || !v.resourceId) return null
  return { kind: 'notification', id: 'notification', resourceKind: v.resourceKind, resourceId: v.resourceId }
}

function parseConversation(raw: unknown): SurfaceConversationPersisted | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (!Array.isArray(v.tabs) || typeof v.visible !== 'boolean') return null
  const tabs = normalizeTabs(v.tabs.map(parseTab).filter((tab): tab is SurfaceTab => tab !== null))
  const activeTabId = typeof v.activeTabId === 'string' && tabs.some((tab) => tab.id === v.activeTabId) ? v.activeTabId : (tabs[0]?.id ?? null)
  return { tabs, activeTabId, visible: v.visible }
}

/** Reads v2 durable state and legacy v1 state for one-time renderer migration. */
export function parseSurfacePersisted(raw: unknown): ParsedSurface | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (v.version === 1 && Array.isArray(v.tabs)) {
    const tabs = normalizeTabs(v.tabs.map(parseTab).filter((tab): tab is SurfaceTab => tab !== null))
    const activeTabId = typeof v.activeTabId === 'string' && tabs.some((tab) => tab.id === v.activeTabId) ? v.activeTabId : (tabs[0]?.id ?? null)
    return { version: 1, tabs, activeTabId }
  }
  if (v.version !== 2 || !Array.isArray(v.pinnedTabs) || !v.conversations || typeof v.conversations !== 'object' || Array.isArray(v.conversations)) return null
  const pinnedTabs = [...new Set(v.pinnedTabs.filter((id): id is PinnableSingletonId => typeof id === 'string' && PINNABLES.has(id)))]
  const notification = parseNotification(v.notification)
  const conversations: Record<string, SurfaceConversationPersisted> = {}
  for (const [tabId, row] of Object.entries(v.conversations as Record<string, unknown>)) {
    if (!tabId) continue
    const parsed = parseConversation(row)
    if (parsed) conversations[tabId] = parsed
  }
  return { version: 2, pinnedTabs: normalizePinnedTabs(pinnedTabs), notification, conversations }
}

export function normalizePinnedTabs(ids: readonly PinnableSingletonId[]): PinnableSingletonId[] {
  return PINNABLE_SINGLETON_IDS.filter((id) => ids.includes(id))
}

export function emptySurfacePersisted(): SurfacePersisted {
  return { version: 2, pinnedTabs: [...DEFAULT_PINNED_SURFACE_TABS], notification: null, conversations: {} }
}

export function isSurfacePersistedV2(raw: unknown): raw is SurfacePersisted {
  return parseSurfacePersisted(raw)?.version === 2
}

/** Main-process write predicate. Legacy payloads only exist to migrate on read. */
export function validateSurfacePersisted(raw: unknown): boolean { return isSurfacePersistedV2(raw) }

export function serializeSurface(pinnedTabs: readonly PinnableSingletonId[], notification: NotificationTab | null, conversations: Readonly<Record<string, SurfaceConversationPersisted>>): SurfacePersisted {
  const serialized: Record<string, SurfaceConversationPersisted> = {}
  for (const [tabId, state] of Object.entries(conversations)) {
    const tabs: SurfaceTab[] = []
    for (const tab of normalizeTabs(state.tabs)) {
      if (tab.kind === 'notification' || tab.kind === 'runtime-panel') continue
      if (tab.kind === 'preview') tabs.push({ kind: 'preview', id: tab.id, filePath: tab.filePath })
      else tabs.push(tab)
    }
    const activeTabId = state.activeTabId && tabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : (tabs[0]?.id ?? null)
    serialized[tabId] = { tabs, activeTabId, visible: state.visible }
  }
  return { version: 2, pinnedTabs: normalizePinnedTabs(pinnedTabs), notification, conversations: serialized }
}
