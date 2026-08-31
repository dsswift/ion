import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import type { ResourceItem } from '../../shared/types-engine'
import { resourceIdentity } from '../../shared/resource-identity'
import { rInfo } from '../rendererLogger'

/**
 * Resource bootstrap: seed the store from the main-process catalog.
 *
 * ── Why this can no longer be a one-shot read ───────────────────────────────
 * Resources are producer-owned: the engine stores no content, and a producer
 * re-announces its own items. The desktop republishes persisted charts when a
 * session subscribes to its resource broker — which happens AFTER the renderer
 * mounts. A single read at boot therefore raced that restoration, saw an empty
 * catalog, and never looked again, so the attachments panel stayed blank until
 * some later chart action produced a live delta.
 *
 * Main now announces catalog changes (`RESOURCE_CATALOG_CHANGED`) and this
 * module re-reads on that signal. The authoritative side decides when the
 * catalog is worth reading; the renderer never guesses.
 */

let inFlight: Promise<void> | null = null
/** Window-lifetime flag: the catalog listener is installed at most once. */
let catalogListenerInstalled = false

/**
 * Read the catalog and merge it into the store.
 *
 * Merges by identity rather than replacing a kind wholesale: a live delta that
 * arrived while this read was in flight must not be clobbered by the older
 * snapshot the read returns. That is the same race in the other direction.
 */
async function readCatalogIntoStore(): Promise<void> {
  const [readResult, resourcesResult] = await Promise.allSettled([
    window.ion.getReadResourceIds(),
    window.ion.getPersistedResources() as Promise<ResourceItem[]>,
  ])
  const readIds = readResult.status === 'fulfilled' ? readResult.value : []
  const items = resourcesResult.status === 'fulfilled' ? resourcesResult.value : []

  const byKind: Record<string, ResourceItem[]> = {}
  const itemReadIds: string[] = []
  for (const item of items) {
    ;(byKind[item.kind] ??= []).push(item)
    if (item.read) itemReadIds.push(resourceIdentity(item))
  }

  useSessionStore.setState((state) => {
    const resources = { ...state.resources }
    for (const [kind, kindItems] of Object.entries(byKind)) {
      const existing = resources[kind] ?? []
      if (existing.length === 0) {
        resources[kind] = kindItems
        continue
      }
      // Union by identity, keeping the LIVE copy of anything already present:
      // a delta is newer than a catalog read that was already in flight.
      const seen = new Set(existing.map((item) => resourceIdentity(item)))
      const additions = kindItems.filter((item) => !seen.has(resourceIdentity(item)))
      if (additions.length > 0) resources[kind] = [...existing, ...additions]
    }
    return {
      resources,
      readResourceIds: new Set([...state.readResourceIds, ...readIds, ...itemReadIds]),
    }
  })

  // INFO, not DEBUG: this line is the evidence that the panel's data actually
  // arrived. A configurable level meant the one diagnostic that mattered was
  // missing from the log at the exact moment it was needed.
  rInfo('resource.bootstrap', 'catalog read into store', {
    kinds: Object.keys(byKind).length,
    items: items.length,
    chart_items: (byKind.chart ?? []).length,
  })
}

/**
 * Bootstrap resources, coalescing concurrent callers.
 *
 * Unlike the previous version this does NOT memoize permanently: the promise
 * is cleared when it settles so a later catalog change can be re-read. The
 * coalescing window only prevents two simultaneous reads.
 */
/**
 * Reset module state. Test-only: the listener flag and in-flight promise are
 * window-lifetime state in production, which a test suite must be able to
 * clear between cases.
 */
export function _resetResourceBootstrapForTest(): void {
  inFlight = null
  catalogListenerInstalled = false
}

export function bootstrapResources(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = readCatalogIntoStore().finally(() => { inFlight = null })
  // Subscribing HERE, on the first read, is what makes the re-read reach every
  // presentation. The subscription previously lived in `useResourceBootstrap`,
  // which only the Studio shell mounts — the Overlay calls `bootstrapResources`
  // directly from `useOwnerBootstrap`. So in the Overlay the announcement had
  // no listener at all and the panel stayed empty exactly as before the fix.
  // The bootstrap function is the one seam both presentations share.
  subscribeToCatalogChanges()
  return inFlight
}

/**
 * Listen for main's catalog-change announcements. Idempotent: the first
 * bootstrap installs the listener and it lives for the window's lifetime,
 * because the catalog can change at any point a session subscribes.
 */
function subscribeToCatalogChanges(): void {
  if (catalogListenerInstalled) return
  if (typeof window === 'undefined' || !window.ion?.onResourceCatalogChanged) return
  catalogListenerInstalled = true
  window.ion.onResourceCatalogChanged(() => {
    rInfo('resource.bootstrap', 'catalog change announced; re-reading')
    void bootstrapResources()
  })
  rInfo('resource.bootstrap', 'subscribed to catalog changes')
}

export function useResourceBootstrap(): void {
  useEffect(() => {
    void bootstrapResources()
  }, [])
}
