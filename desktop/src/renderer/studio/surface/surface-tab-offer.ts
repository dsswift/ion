/**
 * Which Surface tabs a conversation's developer surfaces leave on offer.
 * Free of the Surface store so the store itself can ask before opening a tab.
 */
import type { DeveloperSurfaceState } from '@ion/shared/developer-surfaces'
import { activeDeveloperSurfaces } from '../connection/developer-surfaces'

/** The Git panel holds the changes list and the commit graph, so either keeps it. */
export function gitPanelOffered(surfaces: DeveloperSurfaceState): boolean {
  return surfaces.sourceControl || surfaces.commitGraph
}

/** Whether the Surface tab `id` is on offer under `surfaces`. Only the Git and Diff tabs are developer surfaces. */
export function surfaceTabOffered(id: string, surfaces: DeveloperSurfaceState): boolean {
  if (id === 'gitpanel') return gitPanelOffered(surfaces)
  if (id === 'diff') return surfaces.sourceControl
  return true
}

/** Non-reactive form for the store and shortcut handlers, read against the active conversation. */
export function surfaceTabOfferedNow(id: string): boolean {
  return surfaceTabOffered(id, activeDeveloperSurfaces())
}
