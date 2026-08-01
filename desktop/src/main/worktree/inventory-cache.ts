/**
 * Shared-result store for the worktree inventory service.
 *
 * Deliberately a leaf module (imports nothing from worktree/), so both the
 * service (inventory-service.ts) and the registry mutators in inventory.ts can
 * touch it without an import cycle: the service reads/writes results here, and
 * anything that changes what a crawl would return (register, retire, title,
 * land) calls `invalidateWorktreeInventoryCache` so the next read crawls fresh
 * instead of serving pre-mutation state.
 *
 * Keys are CANONICAL: `git worktree list` answers identically from any
 * checkout of a repo, so the main worktree's path (always listed first) keys
 * one entry and every other checkout path is an alias onto it. Without this,
 * a panel open in the main clone, a picker enumerating 23 worktree paths, and
 * the iOS projection would each maintain their own copy of the same crawl.
 */
import { log as _log } from '../logger'
import type { WorktreeInventoryEntry } from '../../shared/types'

const TAG = 'worktree.inventory'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }

export interface CachedInventory {
  at: number
  entries: WorktreeInventoryEntry[]
}

const cacheByCanonical = new Map<string, CachedInventory>()
const aliasToCanonical = new Map<string, string>()

/** The canonical cache key for `path`, or `path` itself when not yet learned. */
export function resolveInventoryAlias(path: string): string {
  return aliasToCanonical.get(path) ?? path
}

export function getCachedInventory(canonical: string): CachedInventory | undefined {
  return cacheByCanonical.get(canonical)
}

/** Record a crawl result and teach the alias map every path that reaches it. */
export function storeInventory(
  canonical: string,
  aliasPaths: string[],
  entries: WorktreeInventoryEntry[],
): void {
  cacheByCanonical.set(canonical, { at: Date.now(), entries })
  for (const alias of aliasPaths) aliasToCanonical.set(alias, canonical)
  aliasToCanonical.set(canonical, canonical)
}

/**
 * Drop every cached result (the alias map survives — path→repo identity does
 * not change when contents do). Called after any mutation that changes what a
 * crawl would return; `reason` makes the bust attributable in the log.
 */
export function invalidateWorktreeInventoryCache(reason: string): void {
  if (cacheByCanonical.size === 0) return
  cacheByCanonical.clear()
  log('inventory cache invalidated', { reason })
}

export function _resetInventoryCacheForTests(): void {
  cacheByCanonical.clear()
  aliasToCanonical.clear()
}
