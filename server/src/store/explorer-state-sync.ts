/**
 * explorer-state-sync — hydrates the store's file-explorer tree state from
 * disk at boot and persists every local change back.
 *
 * The desktop's two-window convergence funnel (the Overlay and the Studio
 * shell agreeing on one tree through main) has no server-side equivalent: the
 * server store IS the one owner main used to be, so there is no second
 * in-process writer to converge with and no echo to filter. `loadExplorerState`
 * / `saveExplorerState` are the same on-disk owner the desktop's IPC handler
 * delegates to (`server/src/explorer-state-store.ts`); `publishExplorerState`
 * fans the change out over the server's headless broadcast so every connected
 * client converges on what the server accepted (the wire itself is child 07).
 */
import type { StoreApi } from 'zustand'
import type { State } from './session-store-types'
import type { ExplorerStateSnapshot } from '@ion/shared/explorer-state'
import { rDebug, rWarn } from './rendererLogger'
import { loadExplorerState, saveExplorerState } from '../explorer-state-store'
import { publishExplorerState } from '../ipc/explorer-state'

/** Project the store's live Maps into the serializable snapshot main stores. */
export function projectExplorerState(state: State): ExplorerStateSnapshot {
  const expanded: Record<string, string[]> = {}
  const selected: Record<string, string> = {}
  for (const [root, entry] of state.fileExplorerStates) {
    if (entry.expandedPaths.size > 0) expanded[root] = [...entry.expandedPaths]
    if (entry.selectedPath) selected[root] = entry.selectedPath
  }
  return {
    version: 1,
    expanded,
    collapsedRoots: [...state.fileExplorerRootCollapsed],
    selected,
  }
}

/** True when two snapshots describe the same tree, so a publish can be skipped. */
export function sameExplorerState(a: ExplorerStateSnapshot, b: ExplorerStateSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function setupExplorerStateSync(store: StoreApi<State>): () => void {
  // What was last written to disk. A local change that round-trips back to
  // the same value is skipped so an unrelated store update doesn't re-persist
  // and re-broadcast an identical tree on every tick.
  let converged: ExplorerStateSnapshot | null = null

  try {
    const snapshot = loadExplorerState()
    converged = snapshot
    store.getState().applyExplorerState(snapshot)
    rDebug('explorer-state', 'hydrated at boot', {
      roots: Object.keys(snapshot.expanded).length,
      collapsed_roots: snapshot.collapsedRoots.length,
    })
  } catch (err) {
    rWarn('explorer-state', 'hydration failed, starting collapsed', { error: String(err) })
  }

  const unsubscribeStore = store.subscribe((state, previous) => {
    if (
      state.fileExplorerStates === previous.fileExplorerStates &&
      state.fileExplorerRootCollapsed === previous.fileExplorerRootCollapsed
    ) return
    const snapshot = projectExplorerState(state)
    if (converged && sameExplorerState(snapshot, converged)) return
    converged = snapshot
    saveExplorerState(snapshot)
    publishExplorerState(snapshot, 'server')
    rDebug('explorer-state', 'persisted local change', {
      roots: Object.keys(snapshot.expanded).length,
      collapsed_roots: snapshot.collapsedRoots.length,
    })
  })

  return () => {
    unsubscribeStore()
  }
}
