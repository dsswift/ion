/**
 * explorer-state-sync — keeps this window's explorer tree state converged with
 * main's, which is the one owner of it.
 *
 * Three duties: hydrate at boot so the first paint already shows the folders
 * that were open, publish every local change so main can persist it and tell
 * the other presentation, and apply what the other presentation sends back.
 *
 * Both windows run this. Explorer state is not owner-durable state the mirror
 * must forward — it is workbench state either presentation changes and both
 * must see, so it follows the settings funnel rather than the owner/mirror sync
 * channels.
 */
import type { StoreApi } from 'zustand'
import type { State } from './session-store-types'
import type { ExplorerStateSnapshot } from '../../shared/explorer-state'
import { windowRole } from '../lib/window-role'
import { rDebug, rWarn } from '../rendererLogger'

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
  const origin = windowRole()
  const bridge = window.ion
  if (typeof bridge?.loadExplorerState !== 'function' || typeof bridge.publishExplorerState !== 'function') {
    rWarn('explorer-state', 'explorer state bridge unavailable, tree state stays window-local')
    return () => undefined
  }

  // What this window last agreed with main about. Publishing is skipped when a
  // local change round-trips back to the same value, and applying is skipped
  // for our own echo — without both, the two windows would publish each other's
  // snapshots back and forth forever.
  let converged: ExplorerStateSnapshot | null = null

  void bridge
    .loadExplorerState()
    .then((snapshot) => {
      converged = snapshot
      store.getState().applyExplorerState(snapshot)
      rDebug('explorer-state', 'hydrated from main', {
        origin,
        roots: Object.keys(snapshot.expanded).length,
        collapsed_roots: snapshot.collapsedRoots.length,
      })
    })
    .catch((err) => rWarn('explorer-state', 'hydration failed, starting collapsed', { error: String(err) }))

  const unsubscribeBroadcast = bridge.onExplorerStateChanged?.(({ snapshot, origin: from }) => {
    if (from === origin) return
    converged = snapshot
    store.getState().applyExplorerState(snapshot)
    rDebug('explorer-state', 'applied change from the other window', {
      origin,
      from,
      roots: Object.keys(snapshot.expanded).length,
    })
  })

  const unsubscribeStore = store.subscribe((state, previous) => {
    if (
      state.fileExplorerStates === previous.fileExplorerStates &&
      state.fileExplorerRootCollapsed === previous.fileExplorerRootCollapsed
    ) return
    const snapshot = projectExplorerState(state)
    if (converged && sameExplorerState(snapshot, converged)) return
    converged = snapshot
    bridge.publishExplorerState({ snapshot, origin })
    rDebug('explorer-state', 'published local change', {
      origin,
      roots: Object.keys(snapshot.expanded).length,
      collapsed_roots: snapshot.collapsedRoots.length,
    })
  })

  return () => {
    unsubscribeBroadcast?.()
    unsubscribeStore()
  }
}
