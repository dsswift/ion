/**
 * Visibility: filters and scope combined into one `Set<nodeId>`, computed
 * once per filter/scope/model change. The reducer consumes this as a plain
 * set lookup, never a rule evaluation per frame.
 *
 * Scope is applied BEFORE filters so an inclusionary filter never reaches
 * outside the scope the operator asked for.
 */

import type Graph from 'graphology'
import { neighborhood, type NeighborhoodDirection } from '../scope/neighborhood'
import { passesFilters } from './filter-rules'
import type { GraphFilterRule } from '../../../../shared/graph-view-types'
import type { GraphModel } from '../../../../shared/graph-model-types'

export type ScopeMode = 'corpus' | 'neighborhood'

/** The deepest neighborhood an operator can ask for. Past this a "local" graph is most of the corpus. */
export const MAX_SCOPE_DEPTH = 5

export interface GraphScope {
  mode: ScopeMode
  anchorId: string | null
  depth: number
  /** Which way the BFS travels from the anchor. Absent means both ways. */
  direction?: NeighborhoodDirection
  /**
   * Nodes the operator pulled in one at a time (double-click). Each brings
   * its own 1-hop neighbourhood into a neighborhood scope, on top of the
   * anchor's `depth`-hop BFS. Ignored in corpus scope, where everything is
   * already visible. Absent means none.
   */
  expandedIds?: ReadonlySet<string>
}

/** The node set a scope admits before filters run. */
export function scopedNodeIds(model: GraphModel, graph: Graph, scope: GraphScope): Set<string> {
  if (scope.mode === 'corpus' || !scope.anchorId) return new Set(model.nodes.map((n) => n.id))
  const direction = scope.direction ?? 'both'
  const scoped = neighborhood(graph, scope.anchorId, scope.depth, direction)
  for (const id of scope.expandedIds ?? []) {
    for (const member of neighborhood(graph, id, 1, direction)) scoped.add(member)
  }
  return scoped
}

/**
 * The visibility facts that sit beside the rule list. Each is a fact rather
 * than a filter rule so it cannot be edited away in the rule editor and
 * survives a rule set of its own.
 */
export interface VisibilityOptions {
  /** `false` withholds every orphan document — a node with no link in either direction. */
  showOrphans?: boolean
  /** `false` withholds every dangling stub, and with it the broken-link edge that reaches it. The badge still reports them. */
  showDangling?: boolean
  /** Nodes the operator hid one at a time (context menu, `H`). */
  hiddenNodeIds?: ReadonlySet<string>
}

export function computeVisibility(model: GraphModel, graph: Graph, rules: GraphFilterRule[], scope: GraphScope, options: VisibilityOptions = {}): Set<string> {
  const showOrphans = options.showOrphans ?? true
  const showDangling = options.showDangling ?? true
  const hidden = options.hiddenNodeIds
  const scoped = scopedNodeIds(model, graph, scope)

  const byId = new Map(model.nodes.map((n) => [n.id, n]))
  const visible = new Set<string>()
  for (const id of scoped) {
    const node = byId.get(id)
    if (!node) continue
    if (!showOrphans && node.kind === 'document' && node.orphan) continue
    if (!showDangling && node.kind === 'dangling') continue
    if (hidden?.has(id)) continue
    if (passesFilters(node, rules, model)) visible.add(id)
  }
  return visible
}
