/**
 * Which developer surfaces Studio shows, asked per conversation.
 *
 * The answer belongs to the Environment a conversation lives on: a server
 * that does not offer source control has no source-control controls on its
 * conversations, on any client, while a conversation on another server keeps
 * them. This desktop's own device policy narrows every Environment alike.
 * `policyStore.developerSurfacesFor` holds that rule; everything here only
 * picks the Environment to ask about.
 */
import { useMemo, useSyncExternalStore } from 'react'
import type { DeveloperSurface, DeveloperSurfaceState } from '@ion/shared/developer-surfaces'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { policyStore } from './policy-store'
import { activeTabEnvironmentId, environmentOfTab, useActiveTabEnvironmentId, useTabEnvironmentId } from './tab-environment'

const subscribe = (listener: () => void): (() => void) => policyStore.subscribe(listener)

/** The surfaces available on `environmentId`, re-rendering when its policy changes. */
export function useEnvironmentDeveloperSurfaces(environmentId: string): DeveloperSurfaceState {
  return useSyncExternalStore(subscribe, () => policyStore.developerSurfacesFor(environmentId))
}

/** The surfaces available for the conversation `tabId`; the local Environment's when the tab is unknown. */
export function useTabDeveloperSurfaces(tabId: string | null | undefined): DeveloperSurfaceState {
  return useEnvironmentDeveloperSurfaces(useTabEnvironmentId(tabId))
}

/** The surfaces available for the active conversation. */
export function useActiveDeveloperSurfaces(): DeveloperSurfaceState {
  return useEnvironmentDeveloperSurfaces(useActiveTabEnvironmentId())
}

/** Whether `surface` is available for the active conversation. */
export function useActiveDeveloperSurface(surface: DeveloperSurface): boolean {
  return useActiveDeveloperSurfaces()[surface]
}

/** Non-reactive read for handlers, shortcuts, and restore paths. */
export function developerSurfacesForTab(tabId: string | null | undefined): DeveloperSurfaceState {
  return policyStore.developerSurfacesFor(environmentOfTab(tabId) ?? LOCAL_ENVIRONMENT_ID)
}

/** Non-reactive read for the active conversation. */
export function activeDeveloperSurfaces(): DeveloperSurfaceState {
  return policyStore.developerSurfacesFor(activeTabEnvironmentId())
}

/**
 * A lookup from Environment to its available surfaces, for a view that spans
 * Environments (the Inbox). Its identity changes when any policy does, so a
 * memo keyed on it recomputes.
 */
export function useDeveloperSurfacesLookup(): (environmentId: string) => DeveloperSurfaceState {
  const revision = useSyncExternalStore(subscribe, () => policyStore.revision())
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `revision` is the dependency: the store mutates in place
  return useMemo(() => (environmentId: string) => policyStore.developerSurfacesFor(environmentId), [revision])
}
