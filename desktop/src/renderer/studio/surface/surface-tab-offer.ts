/**
 * Which Surface tabs a conversation leaves on offer: its developer surfaces
 * (source control, the commit graph) and its terminal access (terminal tabs and
 * the Ports tab, which forwards ports into a shell's network).
 * Free of the Surface store so the store itself can ask before opening a tab.
 */
import type { DeveloperSurfaceState } from '@ion/shared/developer-surfaces'
import { isTerminalTabId } from '@ion/shared/studio-surface-types'
import { activeDeveloperSurfaces } from '../connection/developer-surfaces'
import { activeTerminalAccess } from '../connection/terminal-access'

/** The Git panel holds the changes list and the commit graph, so either keeps it. */
export function gitPanelOffered(surfaces: DeveloperSurfaceState): boolean {
  return surfaces.sourceControl || surfaces.commitGraph
}

/**
 * Whether the Surface tab `id` is on offer under `surfaces` and `terminalAccess`.
 * The Git and Diff tabs are developer surfaces; terminal tabs and the Ports tab
 * need terminal access. Every other tab is always on offer.
 */
export function surfaceTabOffered(id: string, surfaces: DeveloperSurfaceState, terminalAccess: boolean): boolean {
  if (id === 'gitpanel') return gitPanelOffered(surfaces)
  if (id === 'diff') return surfaces.sourceControl
  if (id === 'ports' || isTerminalTabId(id)) return terminalAccess
  return true
}

/** Non-reactive form for the store and shortcut handlers, read against the active conversation. */
export function surfaceTabOfferedNow(id: string): boolean {
  return surfaceTabOffered(id, activeDeveloperSurfaces(), activeTerminalAccess())
}
