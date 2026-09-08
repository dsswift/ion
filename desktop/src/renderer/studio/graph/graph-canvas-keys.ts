/**
 * The stage's keyboard map. One key each for the verbs the context menu
 * also offers, so an operator reading a graph never has to leave the
 * keyboard: Enter opens, Escape clears, F fits, P pins, E expands, C
 * collapses, H hides. Every verb acts on the newest selected node.
 *
 * Kept beside `GraphCanvas.tsx` so the canvas file stays under the size cap.
 */

import { rDebug } from '../../rendererLogger'
import { useGraphStore } from './graph-store'

/** Whether the key was handled (so the caller can prevent the default). */
export function handleGraphKey(key: string): boolean {
  const store = useGraphStore.getState()
  if (store.contextMenu && key === 'Escape') {
    store.closeContextMenu()
    return true
  }
  const ids = [...store.selectedNodeIds]
  const newest = ids.length > 0 ? ids[ids.length - 1] : null

  switch (key) {
    case 'Escape':
      store.selectNode(null)
      return true
    case 'Enter':
      if (!newest) return false
      store.requestOpenFile(newest)
      return true
    case 'f':
    case 'F': {
      if (store.scope.mode === 'corpus') store.requestCamera({ kind: 'fit-all' })
      else store.requestCamera({ kind: 'fit-nodes', nodeIds: [...store.visibleNodeIds] })
      return true
    }
    case 'p':
    case 'P':
      if (!newest) return false
      store.togglePin(newest)
      return true
    case 'e':
    case 'E':
      if (!newest) return false
      store.drillInto(newest)
      return true
    case 'c':
    case 'C':
      if (!newest) return false
      store.collapseNodeScope(newest)
      return true
    case 'h':
    case 'H':
      if (!newest) return false
      store.hideNode(newest)
      return true
    default:
      rDebug('graph_view', 'graph_view: key ignored', { key })
      return false
  }
}
