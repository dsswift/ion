/**
 * Browser session partitions.
 *
 * Shared because both processes need the same answer: the renderer shows which
 * session a tab is on, and the main process needs it at guest-creation time —
 * which happens without any renderer involvement when a background agent opens
 * a browser tab.
 *
 * The names are a contract, not an implementation detail. `persist:` is what
 * makes cookies and logins survive a restart, and `studio-preview-` is the
 * prefix the offline network block matches on. Renaming any of them silently
 * signs the operator out or drops the preview shield.
 */
import type { BrowserSessionMode } from './studio-surface-types'

/** Preview tabs ride an ephemeral partition whose session blocks network. */
export const PREVIEW_PARTITION_PREFIX = 'studio-preview-'
/** Shared browse tabs ride one persistent partition, so logins are reused. */
export const SHARED_BROWSER_PARTITION = 'persist:studio-browser'
/** A private tab gets its own partition, discarded with the tab. */
export const ISOLATED_PARTITION_PREFIX = 'studio-isolated-'

export function previewPartitionFor(instanceId: string): string {
  return `${PREVIEW_PARTITION_PREFIX}${instanceId}`
}

/** The partition one browser tab runs in. */
export function browserPartitionFor(
  instanceId: string,
  mode: 'preview' | 'browse',
  sessionMode: BrowserSessionMode,
): string {
  if (mode === 'preview') return previewPartitionFor(instanceId)
  return sessionMode === 'shared' ? SHARED_BROWSER_PARTITION : `${ISOLATED_PARTITION_PREFIX}${instanceId}`
}

export function isPreviewPartition(partition: string): boolean {
  return partition.startsWith(PREVIEW_PARTITION_PREFIX)
}
