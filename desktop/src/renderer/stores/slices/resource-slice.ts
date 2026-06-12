import type { ResourceItem, ResourceDelta } from '../../../shared/types-engine'

/**
 * Per-tab resource collections. Keyed by resource kind, each value is
 * an array of ResourceItems that the engine's resource broker delivered
 * via engine_resource_snapshot (full replace) and engine_resource_delta
 * (incremental apply). The store is the single source of truth for
 * resource data on the desktop renderer.
 */
export interface ResourceState {
  /** Resources keyed by kind. Each kind maps to its item collection. */
  resources: Record<string, ResourceItem[]>
  /** Active subscription IDs keyed by kind. */
  resourceSubscriptions: Record<string, string>
  /** IDs of resources the user has opened/viewed. Client-local read tracking. */
  readResourceIds: Set<string>
}

export const initialResourceState: ResourceState = {
  resources: {},
  resourceSubscriptions: {},
  readResourceIds: new Set<string>(),
}

/** Mark a resource as read. Returns updated state. */
export function markResourceRead(state: ResourceState, resourceId: string): ResourceState {
  const updated = new Set(state.readResourceIds)
  updated.add(resourceId)
  return { ...state, readResourceIds: updated }
}

/** Apply a snapshot: replace the entire collection for this kind.
 *
 * Merges read state from the incoming items into readResourceIds. Items
 * carry a `read` flag (set by the producing extension or by the snapshot
 * builder from the desktop's persisted read-state file). Merging here
 * ensures the desktop's in-memory read set stays aligned with the
 * canonical state after a restart, reconnect, or cross-device mark_read
 * that arrived while the desktop was offline. Merge is additive — we
 * never remove an ID from readResourceIds based on snapshot data.
 */
export function applyResourceSnapshot(
  state: ResourceState,
  kind: string,
  subId: string,
  items: ResourceItem[],
): ResourceState {
  // Collect IDs flagged as read in this snapshot batch.
  const newReadIds = items.filter((item) => item.read).map((item) => item.id)
  const readResourceIds =
    newReadIds.length > 0
      ? new Set([...state.readResourceIds, ...newReadIds])
      : state.readResourceIds

  return {
    ...state,
    resources: { ...state.resources, [kind]: items },
    resourceSubscriptions: { ...state.resourceSubscriptions, [kind]: subId },
    readResourceIds,
  }
}

/** Apply a delta: create, update, delete, or mark_read a single item. */
export function applyResourceDelta(
  state: ResourceState,
  kind: string,
  delta: ResourceDelta,
): ResourceState {
  const current = state.resources[kind] ?? []
  let updated: ResourceItem[]

  switch (delta.op) {
    case 'create':
      updated = [...current, delta.item]
      break
    case 'update':
      updated = current.map((item) => (item.id === delta.item.id ? delta.item : item))
      break
    case 'delete':
      updated = current.filter((item) => item.id !== delta.item.id)
      break
    case 'mark_read':
      updated = current.map((item) =>
        item.id === delta.item.id ? { ...item, read: true } : item,
      )
      break
    default:
      updated = current
  }

  const readResourceIds =
    delta.op === 'mark_read'
      ? new Set([...state.readResourceIds, delta.item.id])
      : state.readResourceIds

  return {
    ...state,
    resources: { ...state.resources, [kind]: updated },
    readResourceIds,
  }
}
