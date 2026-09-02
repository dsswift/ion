import type { TerminalInstance, TerminalPaneState } from './types-session'

export interface StudioConversationTerminalPane {
  tabId: string
  instances: TerminalInstance[]
  activeInstanceId: string | null
}

/** Complete owner snapshot for the shared Conversation Terminal Panel. */
export interface StudioConversationTerminalSnapshot {
  revision: number
  panes: StudioConversationTerminalPane[]
  openTabIds: string[]
}

export type StudioConversationTerminalPublish = Omit<StudioConversationTerminalSnapshot, 'revision'>

const MAX_TAB_ID = 128
const MAX_INSTANCE_ID = 128
const MAX_LABEL = 256
const MAX_KIND = 128
const MAX_CWD = 4096
const MAX_PANES = 1000
const MAX_INSTANCES_PER_PANE = 1000

function validString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function validCwd(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_CWD
}

function validInstance(value: unknown): value is TerminalInstance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const instance = value as Partial<TerminalInstance>
  return validString(instance.id, MAX_INSTANCE_ID) &&
    validString(instance.label, MAX_LABEL) &&
    validString(instance.kind, MAX_KIND) &&
    typeof instance.readOnly === 'boolean' &&
    validCwd(instance.cwd)
}

function validPane(value: unknown): value is StudioConversationTerminalPane {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const pane = value as Partial<StudioConversationTerminalPane>
  if (!validString(pane.tabId, MAX_TAB_ID) || !Array.isArray(pane.instances)) return false
  if (!pane.instances.every(validInstance)) return false
  if (new Set(pane.instances.map((instance) => instance.id)).size !== pane.instances.length) return false
  if (pane.activeInstanceId !== null && !validString(pane.activeInstanceId, MAX_INSTANCE_ID)) return false
  return pane.activeInstanceId === null || pane.instances.some((instance) => instance.id === pane.activeInstanceId)
}

export function isStudioConversationTerminalPublish(
  value: unknown,
): value is StudioConversationTerminalPublish {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as Partial<StudioConversationTerminalPublish>
  if (!Array.isArray(snapshot.panes) || snapshot.panes.length > MAX_PANES) return false
  if (!Array.isArray(snapshot.openTabIds) || snapshot.openTabIds.length > MAX_PANES) return false
  if (!snapshot.panes.every((pane) => validPane(pane) && pane.instances.length <= MAX_INSTANCES_PER_PANE)) return false
  if (!snapshot.openTabIds.every((tabId) => validString(tabId, MAX_TAB_ID))) return false
  const paneIds = snapshot.panes.map((pane) => pane.tabId)
  if (new Set(paneIds).size !== paneIds.length) return false
  if (new Set(snapshot.openTabIds).size !== snapshot.openTabIds.length) return false
  const paneIdSet = new Set(paneIds)
  return snapshot.openTabIds.every((tabId) => paneIdSet.has(tabId))
}

export function isStudioConversationTerminalSnapshot(
  value: unknown,
): value is StudioConversationTerminalSnapshot {
  if (!isStudioConversationTerminalPublish(value)) return false
  const revision = (value as Partial<StudioConversationTerminalSnapshot>).revision
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
}

export function projectStudioConversationTerminals(
  terminalPanes: ReadonlyMap<string, TerminalPaneState>,
  terminalOpenTabIds: ReadonlySet<string>,
): StudioConversationTerminalPublish {
  const panes = [...terminalPanes].map(([tabId, pane]) => ({
    tabId,
    instances: pane.instances.map((instance) => ({ ...instance })),
    activeInstanceId: pane.activeInstanceId,
  }))
  const paneIds = new Set(panes.map((pane) => pane.tabId))
  return {
    panes,
    openTabIds: [...terminalOpenTabIds].filter((tabId) => paneIds.has(tabId)),
  }
}

export function terminalPaneMap(
  snapshot: StudioConversationTerminalSnapshot,
): Map<string, TerminalPaneState> {
  return new Map(snapshot.panes.map((pane) => [pane.tabId, {
    instances: pane.instances.map((instance) => ({ ...instance })),
    activeInstanceId: pane.activeInstanceId,
  }]))
}

/** Terminal keys removed by a complete owner snapshot. Studio disposes only its local viewers. */
export function removedConversationTerminalKeys(
  previous: ReadonlyMap<string, TerminalPaneState>,
  next: ReadonlyMap<string, TerminalPaneState>,
): string[] {
  const keys: string[] = []
  for (const [tabId, pane] of previous) {
    const nextIds = new Set(next.get(tabId)?.instances.map((instance) => instance.id) ?? [])
    for (const instance of pane.instances) {
      if (!nextIds.has(instance.id)) keys.push(`${tabId}:${instance.id}`)
    }
  }
  return keys
}
