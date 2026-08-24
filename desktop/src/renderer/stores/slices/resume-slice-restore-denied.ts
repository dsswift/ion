import { lastPendingCardTool, type PendingCardMessage } from '../../../shared/pending-card'

/**
 * Shared restored-permission-denial helper for the resume/fork slices.
 *
 * Lives in its own module because both `resume-slice` (rehydrate paths) and
 * `resume-slice-fork` (mint-from-live-pane paths) need it, and neither should
 * have to import the other. Single seam so every fork/resume/rewind path
 * applies the identical rule.
 */

/** Parse a JSON toolInput string into a Record, or undefined on failure. */
function parseToolInput(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

/**
 * Build a restored `permissionDenied` entry from a message history using the
 * shared pending-card rule (returns null when no card should be restored —
 * e.g. a trailing /clear divider or user message dismissed it).
 */
export function buildRestoredDenied(
  messages: readonly PendingCardMessage[],
): { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> } | null {
  const found = lastPendingCardTool(messages)
  if (!found) return null
  return { tools: [{ toolName: found.toolName, toolUseId: found.toolId || 'restored', toolInput: parseToolInput(found.toolInput) }] }
}

// The questions-panel counterpart lives with the shared pending-card
// helper so BOTH restore paths (this slice and resume-slice-hydration) call
// one implementation.
export { rehydrateQuestionsFromMessages } from '../restored-denied'
