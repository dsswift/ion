/**
 * Search index: label/identity/path lookup over the whole corpus,
 * deliberately ignoring filters and scope (a filtered-out document must
 * still be findable, and choosing it brings it into scope).
 */

import type { GraphModel } from '../../../../shared/graph-model-types'

export interface SearchEntry {
  id: string
  label: string
  identity: string
  path: string | null
  haystack: string
}

export function buildSearchIndex(model: GraphModel): SearchEntry[] {
  return model.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    identity: n.id,
    path: n.path ?? null,
    haystack: `${n.label}\n${n.id}\n${n.path ?? ''}`.toLowerCase(),
  }))
}

interface RankedEntry {
  entry: SearchEntry
  rank: number
}

/** Match label prefix, then label substring, then identity, then path; stable tie-break on label. */
export function query(index: SearchEntry[], q: string, limit = 20): SearchEntry[] {
  const needle = q.trim().toLowerCase()
  if (needle.length === 0) return []

  const ranked: RankedEntry[] = []
  for (const entry of index) {
    const label = entry.label.toLowerCase()
    let rank: number
    if (label.startsWith(needle)) rank = 0
    else if (label.includes(needle)) rank = 1
    else if (entry.identity.toLowerCase().includes(needle)) rank = 2
    else if (entry.path?.toLowerCase().includes(needle)) rank = 3
    else continue
    ranked.push({ entry, rank })
  }

  ranked.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.entry.label.localeCompare(b.entry.label)))
  return ranked.slice(0, limit).map((r) => r.entry)
}
