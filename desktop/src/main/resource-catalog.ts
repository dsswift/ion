import type { ResourceDelta, ResourceItem } from '../shared/types-engine'
import type { ResourceManifest } from '../shared/remote-projection-types'
import { resourceIdentity } from '../shared/resource-identity'
import { log, warn } from './logger'

export type ResourceSnapshotCoverage = string[] | undefined

function normalizedSnapshot(
  existing: ResourceItem[],
  incoming: ResourceItem[],
  coverage: ResourceSnapshotCoverage,
): { items: ResourceItem[]; mode: string; replaced: number; retained: number } {
  let covered: Set<string> | null = null
  let mode = 'explicit'
  if (coverage !== undefined) {
    covered = new Set(coverage)
  } else if (incoming.some((item) => !!item.producer)) {
    covered = new Set(incoming.map((item) => item.producer).filter(Boolean) as string[])
    mode = 'inferred'
  } else if (incoming.length > 0) {
    covered = null
    mode = 'legacy-full'
  } else {
    return { items: existing, mode: 'ambiguous-empty-retain', replaced: 0, retained: existing.length }
  }

  const retained = covered === null
    ? []
    : existing.filter((item) => !item.producer || !covered.has(item.producer))
  const combined = [...retained, ...incoming]
  const byIdentity = new Map<string, ResourceItem>()
  for (const item of combined) {
    const identity = resourceIdentity(item)
    byIdentity.set(identity, retainLoadedContent(byIdentity.get(identity), item))
  }
  return {
    items: [...byIdentity.values()],
    mode,
    replaced: existing.length - retained.length,
    retained: retained.length,
  }
}

function retainLoadedContent(previous: ResourceItem | undefined, incoming: ResourceItem): ResourceItem {
  if (!previous || incoming.content.length > 0 || previous.content.length === 0) return incoming
  return { ...incoming, content: previous.content }
}

export class ResourceCatalog {
  private readonly resources = new Map<string, ResourceItem[]>()
  private readonly snapshots = new Map<string, Map<string, ResourceItem[]>>()

  applySnapshot(source: string, kind: string, incoming: ResourceItem[], coverage: ResourceSnapshotCoverage): void {
    const sourceResources = this.snapshots.get(source) ?? new Map<string, ResourceItem[]>()
    const existing = sourceResources.get(kind) ?? []
    const result = normalizedSnapshot(existing, incoming, coverage)
    sourceResources.set(kind, result.items)
    this.snapshots.set(source, sourceResources)
    this.rebuildKind(kind)
    log('resource_catalog', 'snapshot applied', {
      kind,
      mode: result.mode,
      incoming_count: incoming.length,
      producer_count: coverage?.length ?? -1,
      replaced_count: result.replaced,
      retained_count: result.retained,
      final_count: result.items.length,
    })
  }

  private rebuildKind(kind: string): void {
    const byIdentity = new Map<string, ResourceItem>()
    for (const source of this.snapshots.values()) {
      for (const item of source.get(kind) ?? []) {
        const identity = resourceIdentity(item)
        byIdentity.set(identity, retainLoadedContent(byIdentity.get(identity), item))
      }
    }
    this.resources.set(kind, [...byIdentity.values()])
  }

  applyFullItem(kind: string, item: ResourceItem): void {
    const identity = resourceIdentity(item)
    let sourceCount = 0
    for (const source of this.snapshots.values()) {
      const current = source.get(kind) ?? []
      if (!current.some((value) => resourceIdentity(value) === identity)) continue
      source.set(kind, current.map((value) => resourceIdentity(value) === identity ? item : value))
      sourceCount++
    }
    if (sourceCount === 0) {
      const live = this.snapshots.get('__live__') ?? new Map<string, ResourceItem[]>()
      const current = live.get(kind) ?? []
      const withoutItem = current.filter((value) => resourceIdentity(value) !== identity)
      live.set(kind, [...withoutItem, item])
      this.snapshots.set('__live__', live)
      sourceCount = 1
    }
    this.rebuildKind(kind)
    log('resource_catalog', 'full item applied', {
      kind,
      producer: item.producer ?? '',
      item_id: item.id,
      source_count: sourceCount,
      final_count: (this.resources.get(kind) ?? []).length,
    })
  }

  applyDelta(kind: string, delta: ResourceDelta): void {
    if (!['create', 'update', 'delete', 'mark_read'].includes(delta.op)) {
      warn('resource_catalog', 'unknown delta ignored', { kind, op: delta.op })
      return
    }
    const identity = resourceIdentity(delta.item)
    let matched = false
    for (const source of this.snapshots.values()) {
      const current = source.get(kind) ?? []
      const index = current.findIndex((item) => resourceIdentity(item) === identity)
      if (index < 0) continue
      matched = true
      if (delta.op === 'delete') {
        source.set(kind, current.filter((item) => resourceIdentity(item) !== identity))
      } else {
        source.set(kind, current.map((item) => resourceIdentity(item) === identity
          ? delta.op === 'mark_read' ? { ...item, read: true } : delta.item
          : item))
      }
    }
    if (delta.op === 'create' && !matched) {
      const live = this.snapshots.get('__live__') ?? new Map<string, ResourceItem[]>()
      live.set(kind, [...(live.get(kind) ?? []), delta.item])
      this.snapshots.set('__live__', live)
    }
    if (!matched && delta.op !== 'create') {
      warn('resource_catalog', 'delta target missing', { kind, op: delta.op, item_id: delta.item.id })
    }
    this.rebuildKind(kind)
    log('resource_catalog', 'delta applied', {
      kind,
      op: delta.op,
      item_id: delta.item.id,
      final_count: (this.resources.get(kind) ?? []).length,
    })
  }

  getItem(kind: string, id: string, producer?: string): ResourceItem | undefined {
    return (this.resources.get(kind) ?? []).find((item) => item.id === id && item.producer === producer)
  }

  bootstrapItems(isRead: (id: string, producer?: string, kind?: string) => boolean): ResourceItem[] {
    return [...this.resources.entries()].flatMap(([kind, items]) => items.map((item) => ({
      ...item,
      read: item.read || isRead(item.id, item.producer, kind),
    })))
  }

  manifest(isRead: (id: string, producer?: string, kind?: string) => boolean): ResourceManifest {
    const manifest: ResourceManifest = {}
    for (const [kind, items] of this.resources) {
      manifest[kind] = items.map((item) => ({
        id: item.id,
        kind: item.kind,
        producer: item.producer,
        title: item.title ?? '',
        createdAt: item.createdAt,
        read: item.read || isRead(item.id, item.producer, kind),
        conversationId: item.conversationId || undefined,
      }))
    }
    return manifest
  }

  clear(): void {
    this.resources.clear()
    this.snapshots.clear()
    log('resource_catalog', 'catalog cleared')
  }
}

export const resourceCatalog = new ResourceCatalog()
