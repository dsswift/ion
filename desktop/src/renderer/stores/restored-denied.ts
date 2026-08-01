import { lastPendingCardTool, type PendingCardMessage } from '../../shared/pending-card'

/**
 * Shared pending-card restoration, extracted from resume-slice.ts so BOTH the
 * slice and the lazy-hydration module (resume-slice-hydration.ts) apply the
 * identical rule without either importing the other. The seam is one-way: this
 * module imports nothing from the store slices.
 */

/** Parse a JSON toolInput string into a Record, or undefined on failure. */
export function parseToolInput(raw?: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

/**
 * Build a restored `permissionDenied` entry from a message history using the
 * shared pending-card rule (returns null when no card should be restored —
 * e.g. a trailing /clear divider or user message dismissed it). Single seam so
 * every fork/resume/rewind path applies the identical rule.
 */
export function buildRestoredDenied(
  messages: readonly PendingCardMessage[],
): { tools: Array<{ toolName: string; toolUseId: string; toolInput?: Record<string, unknown> }> } | null {
  const found = lastPendingCardTool(messages)
  if (!found) return null
  return { tools: [{ toolName: found.toolName, toolUseId: found.toolId || 'restored', toolInput: parseToolInput(found.toolInput) }] }
}
