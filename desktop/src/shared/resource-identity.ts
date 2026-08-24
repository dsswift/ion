import type { ResourceItem } from './types-resource'

/**
 * Return the client-side identity for a resource item.
 *
 * Resource IDs were historically unique only within their kind. A producer
 * adds the missing namespace. Keep producerless resources keyed by their raw
 * ID so persisted read state and existing engine payloads remain compatible.
 * A length-prefixed producer makes the composite form unambiguous even when
 * either part contains separators.
 */
export function resourceIdentity(item: Pick<ResourceItem, 'id' | 'producer'> & { kind?: string }): string {
  if (!item.producer) return item.id
  const kind = item.kind ?? ''
  return `${kind.length}:${kind}:${item.producer.length}:${item.producer}:${item.id}`
}

/** Match an item against an ID plus an optional producer from a client command. */
export function resourceMatchesIdentity(
  item: Pick<ResourceItem, 'id' | 'producer'>,
  id: string,
  producer?: string,
): boolean {
  return item.id === id && item.producer === producer
}
