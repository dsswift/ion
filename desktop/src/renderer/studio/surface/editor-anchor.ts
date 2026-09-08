/**
 * The editor anchor: the file tab an operator most recently looked at in a
 * conversation, remembered so Graph View can open on that document's
 * neighborhood.
 *
 * Reading the CURRENTLY active tab cannot work in the Studio surface, where
 * the graph and the editor are tabs in one strip: opening the graph makes
 * the graph active, so the anchor is the graph itself and never a document.
 * That is why the neighborhood-opening scope never once ran — every real
 * launch logged `anchorId: null` and fell back to whole-corpus scope.
 *
 * So the anchor is recorded on activation rather than read at open time:
 * whenever a file tab becomes active it is remembered for that
 * conversation, and opening the graph afterwards asks what was last looked
 * at rather than what is on screen now.
 *
 * Window-local and memory-only, like the graph session park. An anchor is a
 * convenience for choosing an opening view; losing it on reload costs a
 * whole-corpus opening scope, never data.
 */

import type { SurfaceTab } from '../../../shared/studio-surface-types'

const lastFileByConversation = new Map<string, string>()

/**
 * Record a tab activation. Only file tabs move the anchor: activating the
 * graph, a terminal, or the git panel leaves the last document in place,
 * which is the entire point.
 */
export function recordTabActivation(conversationId: string | null, tab: SurfaceTab | undefined): void {
  if (!conversationId || !tab || tab.kind !== 'file') return
  lastFileByConversation.set(conversationId, tab.filePath)
}

/** The file path this conversation last had open in the editor, or null. */
export function lastEditorFilePath(conversationId: string | null): string | null {
  if (!conversationId) return null
  return lastFileByConversation.get(conversationId) ?? null
}

/** Forget a conversation's anchor when its file tab closes and no other file tab remains. */
export function forgetAnchorIfGone(conversationId: string | null, remainingTabs: readonly SurfaceTab[]): void {
  if (!conversationId) return
  const path = lastFileByConversation.get(conversationId)
  if (!path) return
  const stillOpen = remainingTabs.some((t) => t.kind === 'file' && t.filePath === path)
  if (!stillOpen) lastFileByConversation.delete(conversationId)
}

/** Drop every recorded anchor. Test-only reset. */
export function clearAllAnchors(): void {
  lastFileByConversation.clear()
}
