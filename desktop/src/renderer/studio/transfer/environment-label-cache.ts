/**
 * environment-label-cache — resolves an environment id to its catalog label
 * for badge text (spec 15: "Transfer pending seal → <label>", "Transferred
 * to <label>"). One shared in-memory fetch, not one per tab pill: many tab
 * rows may resolve a label in the same render pass, and this repo's catalog
 * read is a full `desktop.json` round trip through IPC.
 */
import { useEffect, useState } from 'react'
import { onCatalogChange, readCatalog } from '../connection/catalog'
import { rDebug, rWarn } from '../../rendererLogger'

/** What a badge needs to say about an environment: its label, and where it is (empty for the local one). */
export interface EnvironmentBadgeInfo {
  label: string
  url: string
}

let cache: Map<string, EnvironmentBadgeInfo> | null = null
let inflight: Promise<Map<string, EnvironmentBadgeInfo>> | null = null

function load(): Promise<Map<string, EnvironmentBadgeInfo>> {
  if (cache) return Promise.resolve(cache)
  if (!inflight) {
    inflight = readCatalog()
      .then((catalog) => {
        cache = new Map(catalog.map((entry) => [entry.id, { label: entry.label, url: entry.target.kind === 'local' ? '' : entry.target.url }]))
        return cache
      })
      .catch((err) => {
        rWarn('transfer.environment-label-cache', 'catalog load failed', { error: String(err) })
        cache = new Map()
        return cache
      })
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

/** Mounted hooks waiting to hear that the cache was dropped, so they resolve again. */
const staleListeners = new Set<() => void>()

/**
 * Drops the cache and tells every mounted hook to resolve again. Runs on
 * every catalog write: a badge mounted before an environment was added
 * would otherwise keep showing that environment's id for the life of the
 * window.
 */
export function invalidateEnvironmentLabelCache(): void {
  cache = null
  inflight = null
  rDebug('transfer.environment-label-cache', 'cache invalidated', { listeners: staleListeners.size })
  for (const listener of [...staleListeners]) listener()
}

onCatalogChange(invalidateEnvironmentLabelCache)

/** A counter that bumps whenever the cache is invalidated; hooks use it as an effect dependency. */
function useCacheGeneration(): number {
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    const listener = (): void => setGeneration((current) => current + 1)
    staleListeners.add(listener)
    return () => { staleListeners.delete(listener) }
  }, [])
  return generation
}

/** The environment's catalog label, or its id until the catalog loads (or if it's unknown). */
export function useEnvironmentLabel(environmentId: string | null): string | null {
  const info = useEnvironmentInfo(environmentId)
  return environmentId ? (info?.label ?? environmentId) : null
}

/** The environment's catalog label and url, or `{label: id, url: ''}` until the catalog loads (null for a null id). */
export function useEnvironmentInfo(environmentId: string | null): EnvironmentBadgeInfo | null {
  const [info, setInfo] = useState<EnvironmentBadgeInfo | null>(environmentId ? (cache?.get(environmentId) ?? null) : null)
  const generation = useCacheGeneration()

  useEffect(() => {
    if (!environmentId) {
      setInfo(null)
      return
    }
    let cancelled = false
    void load().then((resolved) => {
      if (!cancelled) setInfo(resolved.get(environmentId) ?? { label: environmentId, url: '' })
    })
    return () => {
      cancelled = true
    }
  }, [environmentId, generation])

  if (!environmentId) return null
  return info ?? { label: environmentId, url: '' }
}
