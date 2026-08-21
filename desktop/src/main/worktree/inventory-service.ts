/**
 * Worktree inventory service — the single entry point every consumer reads
 * the inventory through.
 *
 * ── The failure this exists to prevent ──────────────────────────────────────
 * The raw crawl (`inventoryWorktrees`) spawns git per worktree. It used to be
 * called directly by four independent consumers — the overlay git panel's 5s
 * poll, the Studio mirror's identical poll, the new-tab directory picker (once
 * per open repo path, and every worktree path is a distinct "repo path"), and
 * the iOS projection — with nothing coalescing them. With 25 worktrees the
 * crawls could not finish inside the poll period under load; overlapping runs
 * piled up without bound and the main process froze inside posix_spawn
 * (73% CPU, minutes of input lag, hide/show stalled).
 *
 * Two mechanisms, both mandatory:
 *  - **Single-flight**: concurrent requests for the same repo await ONE crawl
 *    (same pattern as the history-hydration coalescing in
 *    renderer/stores/resume-slice-hydration.ts).
 *  - **Short shared cache** (TTL = one poll period): the four consumers above
 *    share one crawl per tick instead of running four. Keyed canonically —
 *    all 25 checkout paths of one repo hit one entry (see inventory-cache.ts).
 *
 * Mutations (land, sync, retire, register, title) call
 * `invalidateWorktreeInventoryCache`, so a post-verb refresh never serves
 * pre-verb state. Reads that merely poll tolerate ≤TTL staleness by design —
 * that is the same bound the 5s poll already imposed.
 */
import { inventoryWorktreesDetailed } from './inventory'
import {
  getCachedInventory, resolveInventoryAlias, storeInventory,
} from './inventory-cache'
import { debug as _debug, log as _log, warn as _warn } from '../logger'
import type { WorktreeInventoryEntry } from '../../shared/types'

const TAG = 'worktree.inventory'
function debug(msg: string, fields?: Record<string, unknown>): void { _debug(TAG, msg, fields) }
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * How long a crawl result may be re-served. One renderer poll period: a
 * cached answer is never staler than the cadence consumers already accepted.
 */
const INVENTORY_TTL_MS = 5000

/** In-flight crawls, keyed by the same resolved key the cache uses. */
const inflight = new Map<string, Promise<WorktreeInventoryEntry[]>>()

/**
 * The worktree inventory for `repoPath`, served from the shared cache when
 * fresh, joined onto an in-flight crawl when one is running, crawled otherwise.
 *
 * `repoPath` may be ANY checkout path of the repo (main clone, a worktree, the
 * bench) — they all resolve to one cache entry once the alias is learned. The
 * first-ever call with a never-seen alias while another alias's crawl is in
 * flight can run one redundant crawl; the result teaches the alias map, so it
 * happens at most once per path per process.
 */
export async function getWorktreeInventory(
  repoPath: string,
): Promise<WorktreeInventoryEntry[]> {
  const key = resolveInventoryAlias(repoPath)

  const cached = getCachedInventory(key)
  if (cached && Date.now() - cached.at <= INVENTORY_TTL_MS) {
    debug('inventory served from cache', {
      repo_path: repoPath,
      age_ms: Date.now() - cached.at,
      count: cached.entries.length,
    })
    return cached.entries
  }

  const running = inflight.get(key)
  if (running) {
    // INFO, not debug: "a second consumer wanted a crawl and was coalesced"
    // is exactly the signal that was invisible while the spawn storm built up.
    log('inventory request coalesced into in-flight crawl', { repo_path: repoPath })
    return running
  }

  const crawl = (async () => {
    const result = await inventoryWorktreesDetailed(repoPath)
    if (result.canonicalRepoPath) {
      storeInventory(result.canonicalRepoPath, result.aliasPaths, result.entries)
    } else {
      // Listing failed (not a repo, git unavailable). Nothing cached: the
      // empty answer must not be re-served for a repo that recovers.
      warn('inventory crawl returned no canonical path; result not cached', { repo_path: repoPath })
    }
    return result.entries
  })()

  inflight.set(key, crawl)
  try {
    return await crawl
  } finally {
    inflight.delete(key)
  }
}
