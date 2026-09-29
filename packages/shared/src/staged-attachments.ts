/**
 * staged-attachments — the staging area's attachment shape, in one place.
 *
 * `TabState.attachments` is the input bar's staging tray: what the user has
 * attached but not yet sent. Three paths need to put attachments back into it
 * (restore-from-disk, rewind, fork), and each needs the same two narrowings:
 *
 *  - A `Message.attachments` row is `Attachment[]` — `FileAttachment` OR
 *    `PlanAttachment`. The tray only holds `FileAttachment`. A plan pointer is
 *    a rendering of the run that produced it, not a file the user staged, so
 *    re-staging it would attach a plan the user never picked.
 *  - `dataUrl` is a base64 preview thumbnail (main/ipc/attachments.ts only
 *    fills it under 2 MB). It is NOT load-bearing for send: prompt-pipeline's
 *    encodeAttachments re-reads the bytes from `path`, which is permanent
 *    content-addressed storage. Persisting it would inline megabytes of base64
 *    into tabs.json on every 100 ms debounced save, so persistence strips it
 *    and the preview is re-derived from `path` after restore.
 */

import type { Attachment, FileAttachment } from './types-session'

/**
 * Narrow a message's attachments to the ones the staging tray can hold.
 * Returns a new array; never mutates the source row.
 */
export function stageableAttachments(attachments?: Attachment[]): FileAttachment[] {
  if (!attachments || attachments.length === 0) return []
  return attachments.filter((a): a is FileAttachment => a.type !== 'plan')
}

/**
 * The on-disk form: identity and path, no base64 preview. `path` is what makes
 * this lossless — the preview is regenerated from it on restore.
 */
export function persistableAttachments(attachments: FileAttachment[]): FileAttachment[] {
  return attachments.map(({ dataUrl: _dataUrl, ...rest }) => rest)
}

/** True when the row was persisted without its preview and can be rehydrated. */
export function needsPreviewRehydration(a: FileAttachment): boolean {
  return a.type === 'image' && !a.dataUrl && a.path !== ''
}
