/**
 * Which Surface tabs a conversation's developer surfaces leave on offer.
 *
 * A Surface tab outlives the conversation it was opened from: it is restored
 * from a saved layout and stays in the strip across conversation switches.
 * So the gate is applied where tabs are read and where they are opened,
 * never by deleting a tab, and a tab returns as soon as the active
 * conversation is on a server that offers it.
 */
import { useMemo } from 'react'
import type { SurfaceTab } from '@ion/shared/studio-surface-types'
import { useActiveDeveloperSurfaces } from '../connection/developer-surfaces'
import { useSurfaceStore } from './surface-store'
import { surfaceTabOffered } from './surface-tab-offer'

/**
 * The Surface tabs to render for the active conversation, and the tab to
 * show. When the stored active tab is not on offer the first offered tab
 * stands in, so the panel never shows a body the strip has no pill for.
 */
export function useOfferedSurfaceTabs(): { tabs: SurfaceTab[]; activeTabId: string | null } {
  const tabs = useSurfaceStore((s) => s.tabs)
  const activeTabId = useSurfaceStore((s) => s.activeTabId)
  const surfaces = useActiveDeveloperSurfaces()
  return useMemo(() => {
    const offered = tabs.filter((tab) => surfaceTabOffered(tab.id, surfaces))
    if (offered.length === tabs.length) return { tabs, activeTabId }
    const activeOffered = activeTabId !== null && offered.some((tab) => tab.id === activeTabId)
    return { tabs: offered, activeTabId: activeOffered ? activeTabId : (offered[0]?.id ?? null) }
  }, [tabs, activeTabId, surfaces])
}
