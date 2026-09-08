/**
 * The bindable dimension catalog: the live, corpus-derived list a binding
 * panel offers, built fresh from `model.discoveredFields` plus the
 * always-available structural and mechanical families. A hardcoded list
 * would put the corpus's vocabulary back into the mechanism — the defect
 * this whole feature exists to avoid.
 */

import type { ChannelDimension, GraphViewCuratedField, TagTreatment } from '../../../../shared/graph-view-types'
import type { GraphModel } from '../../../../shared/graph-model-types'

export interface CatalogEntry {
  dimension: ChannelDimension
  displayName: string
  order: number
  family: 'structural' | 'mechanical' | 'edge' | 'front-matter'
}

const STRUCTURAL_ENTRIES: { metric: 'degree' | 'community' | 'centrality' | 'orphan'; displayName: string }[] = [
  { metric: 'degree', displayName: 'Degree' },
  { metric: 'community', displayName: 'Community' },
  { metric: 'centrality', displayName: 'Centrality' },
  { metric: 'orphan', displayName: 'Orphan' },
]

const MECHANICAL_ENTRIES: { property: 'path' | 'root' | 'sizeBytes' | 'modifiedMs'; displayName: string }[] = [
  { property: 'path', displayName: 'Path' },
  { property: 'root', displayName: 'Root' },
  { property: 'sizeBytes', displayName: 'File size' },
  { property: 'modifiedMs', displayName: 'Modified' },
]

const EDGE_ENTRIES: { metric: 'multiplicity' | 'recency' | 'rarity' | 'overlap' | 'crossRoot' | 'origin' | 'field'; displayName: string }[] = [
  { metric: 'origin', displayName: 'Edge kind' },
  { metric: 'field', displayName: 'Source field' },
  { metric: 'multiplicity', displayName: 'Link multiplicity' },
  { metric: 'recency', displayName: 'Edge recency' },
  { metric: 'rarity', displayName: 'Corpus rarity' },
  { metric: 'overlap', displayName: 'Tag/topic overlap' },
  { metric: 'crossRoot', displayName: 'Cross-root' },
]

/** How the tag field participates, when the caller knows. Omitted means "offer everything". */
export interface TagCatalogContext {
  tagField: string
  tagTreatment: TagTreatment
}

/**
 * Build the live bindable dimension list for a node or edge channel.
 * Curated metadata applies a friendly display name and explicit ordering,
 * and `hidden` removes an entry from THIS LIST ONLY — the field stays in
 * the model and stays filterable.
 *
 * `tags` additionally governs the tag field: under `'off'` it is withheld,
 * because "no tag involvement in the graph" has to include the binding and
 * filter catalog. Without that, `'off'` and `'filter'` are the same setting
 * under two names.
 */
export function buildDimensionCatalog(
  model: GraphModel,
  curatedFields: GraphViewCuratedField[],
  target: 'node' | 'edge',
  tags?: TagCatalogContext,
): CatalogEntry[] {
  const curatedByField = new Map(curatedFields.map((c) => [c.field, c]))
  const entries: CatalogEntry[] = []
  let orderCounter = 0

  if (target === 'node') {
    for (const s of STRUCTURAL_ENTRIES) {
      entries.push({ dimension: { source: 'structural', metric: s.metric }, displayName: s.displayName, order: orderCounter++, family: 'structural' })
    }
    for (const m of MECHANICAL_ENTRIES) {
      entries.push({ dimension: { source: 'mechanical', property: m.property }, displayName: m.displayName, order: orderCounter++, family: 'mechanical' })
    }
  } else {
    for (const e of EDGE_ENTRIES) {
      entries.push({ dimension: { source: 'edge', metric: e.metric }, displayName: e.displayName, order: orderCounter++, family: 'edge' })
    }
  }

  for (const field of model.discoveredFields) {
    const curated = curatedByField.get(field)
    if (curated?.hidden) continue
    if (tags && tags.tagTreatment === 'off' && field === tags.tagField) continue
    entries.push({
      dimension: { source: 'frontMatter', field },
      displayName: curated?.displayName ?? field,
      order: curated?.order ?? orderCounter++,
      family: 'front-matter',
    })
  }

  // Stable sort: curated order first (when explicitly set), then family
  // declaration order, then alphabetical by display name.
  return entries.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    return a.displayName.localeCompare(b.displayName)
  })
}
