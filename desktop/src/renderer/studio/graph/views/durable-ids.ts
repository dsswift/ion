/**
 * Which node ids may be written into a durable artifact (a saved view).
 *
 * A document with no identity is keyed by its path for one read only; a
 * section's identity is derived from its heading and ordinal; a dangling
 * stub is named by the reference that failed to resolve. None of those
 * survive the next read unchanged, so persisting one leaves a saved view
 * pointing at a key that no longer exists. A document keyed by a real
 * identity, a group by its value, and an anchor by its value are durable.
 */

import type { GraphModel } from '../../../../shared/graph-model-types'

/** A predicate over node ids for the current model. Unknown ids are not durable. */
export function durableIdPredicate(model: GraphModel | null): (id: string) => boolean {
  const durable = new Set<string>()
  for (const n of model?.nodes ?? []) {
    if (n.kind === 'section' || n.kind === 'dangling') continue
    if (n.kind === 'document' && n.id === n.path) continue
    durable.add(n.id)
  }
  return (id) => durable.has(id)
}
