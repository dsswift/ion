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
): ResourceState {
  // Guard: protect disk-seeded items from being lost to partial or empty snapshots.
  //
  // Multiple sessions fire engine_resource_snapshot on connect. If the extension's
  // HandleQuery fails (subprocess died mid-query) or the subscription races with
  // extension init, the snapshot arrives with 0 items. After extension respawn,
  // RewireQueryHandlerAndResnapshot fires but the fresh subprocess may only return
  // items from its current session (e.g. 2 items when disk has 13). Without this
  // guard, both cases wipe the disk-seeded collection.
  //
  // Strategy:
  //   - Empty snapshot (items=0): keep existing. Extension wasn't ready.
  //   - Full snapshot (items >= existing): use incoming. It's authoritative.
  //   - Partial snapshot (items < existing): merge. Union existing + incoming,
  //     deduplicating by ID so incoming items win on conflict (they're freshest).
  const existing = state.resources[kind] ?? []
  let merged: ResourceItem[]
  if (items.length === 0) {
    merged = existing
  } else if (items.length >= existing.length) {
    merged = items
  } else {
    // Partial snapshot: take the union so no disk-seeded items are lost.
    const incomingById = new Map(items.map((item) => [item.id, item]))
    const survivingExisting = existing.filter((item) => !incomingById.has(item.id))
    merged = [...survivingExisting, ...items]
  }

  // Normalize: deduplicate by ID so duplicate-ID items from a buggy producer
  // or a race between snapshot and delta never stack. Last occurrence wins.
  const seen = new Set<string>()
  const normalized: ResourceItem[] = []
  for (let i = merged.length - 1; i >= 0; i--) {
    if (!seen.has(merged[i].id)) {
      seen.add(merged[i].id)
      normalized.push(merged[i])
    }
  }
  normalized.reverse()
  merged = normalized

  // Snapshot read state is authoritative for every retained item in this kind.
  // Remove prior flags before applying final normalized values, otherwise an
  // earlier duplicate marked read survives a final unread occurrence.
  const readResourceIds = new Set(state.readResourceIds)
  for (const item of merged) readResourceIds.delete(item.id)
  for (const item of merged) {
    if (item.read) readResourceIds.add(item.id)
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
      const existingIdx = current.findIndex((item) => item.id === delta.item.id)
      updated = existingIdx >= 0
        ? current.map((item, i) => (i === existingIdx ? delta.item : item))
        : [...current, delta.item]
      break
    }
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
