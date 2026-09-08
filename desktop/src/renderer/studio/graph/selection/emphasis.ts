/**
 * Selection emphasis: the set of nodes that stay at full strength while a
 * selection is active — every selected node plus its immediate neighbours.
 * Everything outside it is drawn dimmed by the reducers. This is
 * focus-by-emphasis, the counterpart to scope's focus-by-hiding: scope
 * answers "show me only this neighbourhood", emphasis answers "keep the
 * whole picture, but make this part read first".
 *
 * Reuses the scope BFS at depth 1 so the two features agree on what a
 * neighbour is (direction ignored).
 */

import type Graph from 'graphology'
import { neighborhood } from '../scope/neighborhood'

/** Union of the 1-hop neighbourhoods of every selected node. Empty when nothing is selected. */
export function computeEmphasis(graph: Graph | null, selected: ReadonlySet<string>): Set<string> {
  const emphasis = new Set<string>()
  if (!graph || selected.size === 0) return emphasis
  for (const id of selected) {
    for (const member of neighborhood(graph, id, 1)) emphasis.add(member)
    // A selected node that has since left the graph still reads as selected
    // (the inspector may be showing it) — keep it in the set so it is never
    // dimmed against itself.
    emphasis.add(id)
  }
  return emphasis
}
