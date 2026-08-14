/**
 * conflict-assist-dedupe — per-directory deduplication for conflict-assist tabs.
 *
 * Two guarantees:
 *   1. If a `conflict-auto-fix` tab already exists for a directory, callers
 *      get its id back instead of spawning a second one.
 *   2. If `openConflictAssist` is already in flight for a directory (tab not
 *      yet tagged), concurrent callers await the same promise instead of
 *      racing two fresh tabs into existence.
 *
 * Different directories may run concurrently — the dedup is per-directory.
 */
import type { TabState } from '../../../shared/types-session'

/**
 * Find an existing conflict-auto-fix tab whose working directory matches.
 * Returns the tab id, or null if none exists.
 */
export function findActiveAutoFix(
  tabs: readonly Pick<TabState, 'id' | 'tabRole' | 'workingDirectory'>[],
  directory: string,
): string | null {
  const tab = tabs.find(
    (t) => t.tabRole === 'conflict-auto-fix' && t.workingDirectory === directory,
  )
  return tab?.id ?? null
}

const inflight = new Map<string, Promise<string>>()

export function getInflight(directory: string): Promise<string> | undefined {
  return inflight.get(directory)
}

export function setInflight(directory: string, promise: Promise<string>): void {
  inflight.set(directory, promise)
}

export function clearInflight(directory: string): void {
  inflight.delete(directory)
}
