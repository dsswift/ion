import {
  DEFAULT_PINNED_SURFACE_TABS,
  PINNABLE_SINGLETON_IDS,
  SINGLETON_ORDER,
  isBrowserTab,
  type LegacySurfacePersisted,
  type NotificationTab,
  type PinnableSingletonId,
  type ScratchDocument,
  type ScratchProject,
  type SurfaceConversationPersisted,
  type SurfacePersisted,
  type SurfaceTab,
} from './studio-surface-types'
import { parseBrowserEmulation } from './studio-browser-types'
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
  if (v.kind === 'dispatch') {
    if (typeof v.agentName !== 'string' || !v.agentName || typeof v.dispatchId !== 'string' || !v.dispatchId) return null
    return { kind: 'dispatch', id: 'dispatch-preview', agentName: v.agentName, dispatchId: v.dispatchId, title: typeof v.title === 'string' && v.title ? v.title : v.agentName }
  }
  if (v.kind === 'browser') {
    if (typeof v.instanceId !== 'string' || !v.instanceId || typeof v.url !== 'string') return null
    // A malformed emulation is DROPPED, not fatal: the tab still exists and is
    // usable responsively. Losing a viewport override is recoverable; losing
    // the whole tab (and its place in the pointer) is not.
    const emulation = parseBrowserEmulation(v.emulation)
    return {
      kind: 'browser',
      id: `browser:${v.instanceId}`,
      instanceId: v.instanceId,
      url: v.url,
      title: typeof v.title === 'string' ? v.title : '',
      mode: v.mode === 'preview' ? 'preview' : 'browse',
      sessionMode: v.sessionMode === 'isolated' ? 'isolated' : 'shared',
      ...(emulation ? { emulation } : {}),
    }
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
  return { kind: 'notification', id: 'notification', resourceKind: v.resourceKind, resourceId: v.resourceId, ...(typeof v.resourceProducer === 'string' && v.resourceProducer ? { resourceProducer: v.resourceProducer } : {}) }
}

/**
 * Resolve one conversation's Agent-linked browser pointer.
 *
 * `backfill` is the v2→v3 migration switch and the ONLY place a pointer is
 * invented. On a v2 record the field never existed, so the first browser tab
 * (whatever its mode — a `preview` tab that happens to be first counts) becomes
 * the linked one. On a v3 record `null` is a decision the operator made, so it
 * is preserved verbatim.
 *
 * Whatever the source, a NON-null pointer is validated against the live tab
 * set: a pointer to a tab that is gone falls back to the first browser tab,
 * then to null. That repairs a record whose linked tab was removed by an
 * external edit or a partial write without leaving a dangling pointer that
 * would make the strip claim a link nothing renders.
 */
function resolveAgentBrowser(raw: unknown, tabs: readonly SurfaceTab[], backfill: boolean): string | null {
  const browsers = tabs.filter(isBrowserTab)
  const firstBrowser = browsers[0]?.instanceId ?? null
  const candidate = typeof raw === 'string' && raw ? raw : (backfill ? firstBrowser : null)
  if (!candidate) return null
  return browsers.some((tab) => tab.instanceId === candidate) ? candidate : firstBrowser
}

function parseConversation(
  raw: unknown,
  pinnedTabs: readonly PinnableSingletonId[] = [],
  notification: NotificationTab | null = null,
  backfillAgentBrowser = false,
  extraSelectableIds: readonly string[] = [],
): SurfaceConversationPersisted | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (!Array.isArray(v.tabs) || typeof v.visible !== 'boolean') return null
  const parsedTabs = v.tabs.map(parseTab).filter((tab): tab is SurfaceTab => tab !== null)
  const agentBrowserInstanceId = resolveAgentBrowser(v.agentBrowserInstanceId, parsedTabs, backfillAgentBrowser)
  const tabs = normalizeTabs(parsedTabs, agentBrowserInstanceId)
  const selectableIds = new Set([
    ...pinnedTabs,
    ...tabs.map((tab) => tab.id),
    ...extraSelectableIds,
    ...(notification ? [notification.id] : []),
  ])
  const activeTabId = typeof v.activeTabId === 'string' && selectableIds.has(v.activeTabId)
    ? v.activeTabId
    : (pinnedTabs[0] ?? tabs[0]?.id ?? notification?.id ?? null)
  return { tabs, activeTabId, visible: v.visible, agentBrowserInstanceId }
}

function parseScratchDocument(raw: unknown): ScratchDocument | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || !value.id || typeof value.fileName !== 'string' || !value.fileName || typeof value.content !== 'string' || typeof value.isPreview !== 'boolean') return null
  if (value.savedContent !== undefined && typeof value.savedContent !== 'string') return null
  if (value.wordWrap !== undefined && typeof value.wordWrap !== 'boolean') return null
  return {
    id: value.id,
    fileName: value.fileName,
    content: value.content,
    savedContent: typeof value.savedContent === 'string' ? value.savedContent : '',
    isPreview: value.isPreview,
    ...(typeof value.wordWrap === 'boolean' ? { wordWrap: value.wordWrap } : {}),
  }
}

function parseScratchProjects(raw: unknown): Record<string, ScratchProject> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const projects: Record<string, ScratchProject> = {}
  for (const [projectKey, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!projectKey || !value || typeof value !== 'object') continue
    const documentsRaw = (value as Record<string, unknown>).documents
    if (!Array.isArray(documentsRaw)) continue
    const seen = new Set<string>()
    const documents = documentsRaw
      .map(parseScratchDocument)
      .filter((document): document is ScratchDocument => document !== null && !seen.has(document.id) && !!seen.add(document.id))
    if (documents.length > 0) projects[projectKey] = { documents }
  }
  return projects
}

/** Reads v4 durable state and migrates versions 1–3. */
export function parseSurfacePersisted(raw: unknown): ParsedSurface | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (v.version === 1 && Array.isArray(v.tabs)) {
    const tabs = normalizeTabs(v.tabs.map(parseTab).filter((tab): tab is SurfaceTab => tab !== null))
    const activeTabId = typeof v.activeTabId === 'string' && tabs.some((tab) => tab.id === v.activeTabId) ? v.activeTabId : (tabs[0]?.id ?? null)
    return { version: 1, tabs, activeTabId }
  }
  const isV2 = v.version === 2
  const isCurrent = v.version === 4
  if ((!isCurrent && v.version !== 3 && !isV2) || !Array.isArray(v.pinnedTabs) || !v.conversations || typeof v.conversations !== 'object' || Array.isArray(v.conversations)) return null
  const pinnedTabs = normalizePinnedTabs([...new Set(v.pinnedTabs.filter((id): id is PinnableSingletonId => typeof id === 'string' && PINNABLES.has(id)))])
  const notification = parseNotification(v.notification)
  const scratchProjects = isCurrent ? parseScratchProjects(v.scratchProjects) : {}
  const scratchIds = Object.values(scratchProjects).flatMap((project) => project.documents.map((document) => `scratch:${document.id}`))
  const conversations: Record<string, SurfaceConversationPersisted> = {}
  for (const [tabId, row] of Object.entries(v.conversations as Record<string, unknown>)) {
    if (!tabId) continue
    // v2 records predate the pointer, so each conversation back-fills its
    // first browser tab exactly once, on this read. The v3 write that follows
    // makes the result durable, and a later null then stays null.
    const parsed = parseConversation(row, pinnedTabs, notification, isV2, scratchIds)
    if (parsed) conversations[tabId] = parsed
  }
  return { version: 4, pinnedTabs, notification, conversations, scratchProjects }
}

export function normalizePinnedTabs(ids: readonly PinnableSingletonId[]): PinnableSingletonId[] {
  return PINNABLE_SINGLETON_IDS.filter((id) => ids.includes(id))
}

export function emptySurfacePersisted(): SurfacePersisted {
  return { version: 4, pinnedTabs: [...DEFAULT_PINNED_SURFACE_TABS], notification: null, conversations: {}, scratchProjects: {} }
}

export function isSurfacePersistedV4(raw: unknown): raw is SurfacePersisted {
  if (!raw || typeof raw !== 'object') return false
  const value = raw as Record<string, unknown>
  if (value.version !== 4 || !value.scratchProjects || typeof value.scratchProjects !== 'object' || Array.isArray(value.scratchProjects)) return false
  return parseSurfacePersisted(raw)?.version === 4
}

/**
 * Main-process write predicate. Only the current version is a legal write:
 * v1 and v2 payloads exist to migrate on read, never to be written back.
 */
export function validateSurfacePersisted(raw: unknown): boolean { return isSurfacePersistedV4(raw) }

export function serializeSurface(
  pinnedTabs: readonly PinnableSingletonId[],
  notification: NotificationTab | null,
  conversations: Readonly<Record<string, SurfaceConversationPersisted>>,
  scratchProjects: Readonly<Record<string, ScratchProject>> = {},
): SurfacePersisted {
  const scratchIds = Object.values(scratchProjects).flatMap((project) => project.documents.map((document) => `scratch:${document.id}`))
  const serialized: Record<string, SurfaceConversationPersisted> = {}
  for (const [tabId, state] of Object.entries(conversations)) {
    const tabs: SurfaceTab[] = []
    for (const tab of normalizeTabs(state.tabs, state.agentBrowserInstanceId)) {
      // questions is window-transient (derived from live coordinator state);
      // notification is global (serialized separately); runtime panels exist
      // only while their producer runs. None belongs in a conversation row.
      if (tab.kind === 'notification' || tab.kind === 'runtime-panel' || tab.kind === 'questions' || tab.kind === 'scratch') continue
      if (tab.kind === 'preview') tabs.push({ kind: 'preview', id: tab.id, filePath: tab.filePath })
      else tabs.push(tab)
    }
    const composedIds = new Set([
      ...pinnedTabs,
      ...tabs.map((tab) => tab.id),
      ...scratchIds,
      ...(notification ? [notification.id] : []),
    ])
    const activeTabId = state.activeTabId && composedIds.has(state.activeTabId)
      ? state.activeTabId
      : (pinnedTabs[0] ?? tabs[0]?.id ?? notification?.id ?? null)
    // The pointer is written as-is when it still names a live browser tab, and
    // as null otherwise. It is never back-filled here: a null that reaches
    // serialization is the operator's decision, and inventing a replacement
    // would re-link the tab the round-trip is supposed to keep unlinked.
    const agentBrowserInstanceId = state.agentBrowserInstanceId && tabs.some((tab) => isBrowserTab(tab) && tab.instanceId === state.agentBrowserInstanceId)
      ? state.agentBrowserInstanceId
      : null
    // Skip a record that carries nothing worth restoring.
    //
    // A conversation gets a record the moment the operator clicks a GLOBAL
    // pinned tab (Diff, Plan) while in it, because that writes activeTabId.
    // Those pins are already stored once at the top level, so the row adds
    // nothing — yet nothing ever pruned it. On this machine that produced 539
    // empty records against 40 real ones, 82KB of settings.json rewritten on
    // every surface change.
    //
    // The keep condition is "does this row say anything the top level does
    // not": own tabs, an open panel, a linked browser, or a pointer at
    // something other than a global pin.
    const pointsAtOwnTab = activeTabId !== null && !pinnedTabs.includes(activeTabId as PinnableSingletonId) && activeTabId !== notification?.id
    const worthKeeping = tabs.length > 0 || state.visible || agentBrowserInstanceId !== null || pointsAtOwnTab
    if (!worthKeeping) continue
    serialized[tabId] = { tabs, activeTabId, visible: state.visible, agentBrowserInstanceId }
  }
  const persistedScratchProjects: Record<string, ScratchProject> = {}
  for (const [projectKey, project] of Object.entries(scratchProjects)) {
    const documents = project.documents.map(({ saveError: _saveError, ...document }) => document)
    if (documents.length > 0) persistedScratchProjects[projectKey] = { documents }
  }
  return {
    version: 4,
    pinnedTabs: normalizePinnedTabs(pinnedTabs),
    notification,
    conversations: serialized,
    scratchProjects: persistedScratchProjects,
  }
}
