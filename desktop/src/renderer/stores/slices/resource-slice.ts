import type { ResourceItem, ResourceDelta } from '../../../shared/types-engine'
import { resourceIdentity } from '../../../shared/resource-identity'

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

/**
 * Mark multiple resources as read in a single state transition. Batched
 * analogue of markResourceRead used by the notifications panel's "Clear all"
 * action — unions every id into readResourceIds at once rather than producing
 * N intermediate states. An empty list is a no-op (returns a new set with the
 * same membership). Engine fan-out (the per-item mark_read delta that informs
 * other subscribers like iOS) is handled by the caller, not here; this helper
 * only owns the local read-state set.
 */
export function markResourcesRead(state: ResourceState, ids: string[]): ResourceState {
  if (ids.length === 0) return state
  const updated = new Set(state.readResourceIds)
  for (const id of ids) updated.add(id)
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
  resourceProducers?: string[],
): ResourceState {
  const existing = state.resources[kind] ?? []
  let covered: Set<string> | null
  if (resourceProducers !== undefined) {
    covered = new Set(resourceProducers)
  } else if (items.some((item) => !!item.producer)) {
    covered = new Set(items.map((item) => item.producer).filter(Boolean) as string[])
  } else if (items.length > 0) {
    covered = null
  } else {
    covered = new Set()
  }
  const retained = covered === null
    ? []
    : existing.filter((item) => !item.producer || !covered.has(item.producer))
  let merged = [...retained, ...items]

  // Normalize: deduplicate by producer + ID so same-kind producers can use
  // the same item ID without overwriting one another. Producerless items retain
  // their historic raw-ID identity for compatibility.
  const seen = new Set<string>()
  const normalized: ResourceItem[] = []
  for (let i = merged.length - 1; i >= 0; i--) {
    const identity = resourceIdentity(merged[i])
    if (!seen.has(identity)) {
      seen.add(identity)
      normalized.push(merged[i])
    }
  }
  normalized.reverse()
  merged = normalized

  // Snapshot read state is authoritative only for the producers this snapshot
  // covers. Preserve read state owned by retained producers.
  const readResourceIds = new Set(state.readResourceIds)
  const affected = covered === null
    ? merged
    : merged.filter((item) => !!item.producer && covered.has(item.producer))
  const legacyReadIds = new Set(
    affected
      .filter((item) => resourceIdentity(item) !== item.id && state.readResourceIds.has(item.id))
      .map((item) => item.id),
  )
  for (const item of affected) {
    readResourceIds.delete(resourceIdentity(item))
    if (legacyReadIds.has(item.id)) readResourceIds.delete(item.id)
  }
  for (const item of affected) {
    if (item.read || legacyReadIds.has(item.id)) readResourceIds.add(resourceIdentity(item))
  }

  return {
    ...state,
    resources: { ...state.resources, [kind]: merged },
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
    case 'create': {
      const existingIdx = current.findIndex((item) => resourceIdentity(item) === resourceIdentity(delta.item))
      updated = existingIdx >= 0
        ? current.map((item, i) => (i === existingIdx ? delta.item : item))
        : [...current, delta.item]
      break
    }
    case 'update':
      updated = current.map((item) => (resourceIdentity(item) === resourceIdentity(delta.item) ? delta.item : item))
      break
    case 'delete':
      updated = current.filter((item) => resourceIdentity(item) !== resourceIdentity(delta.item))
      break
    case 'mark_read':
      updated = current.map((item) =>
        resourceIdentity(item) === resourceIdentity(delta.item) ? { ...item, read: true } : item,
      )
      break
    default:
      updated = current
  }

  const readResourceIds =
    delta.op === 'mark_read'
      ? new Set([...state.readResourceIds, resourceIdentity(delta.item)])
      : state.readResourceIds

  return {
    ...state,
    resources: { ...state.resources, [kind]: updated },
    readResourceIds,
  }
}
