import type { ResourceItem } from '../../shared/types-engine'

/**
 * Pure selector for the global notification tray.
 *
 * Given the flat resource map (keyed by kind) and the user's
 * `excludedResourceKinds` blocklist, returns the items the global tray should
 * show, newest-first.
 *
 * Rules (kind-agnostic, blocklist semantics):
 *   - Only workspace/global items are eligible (no `conversationId`).
 *     Conversation-scoped resources are shown in the per-conversation
 *     attachments panel and are NEVER affected by the blocklist.
 *   - A workspace item is hidden iff its `kind` is in `excludedKinds`.
 *   - An empty blocklist (the default) shows every kind.
 *
 * Extracting this from the React component gives a stable, unit-testable seam
 * for the parity-critical filter behavior.
 */
export function selectTrayResources(
  resources: Record<string, ResourceItem[]>,
  excludedKinds: Iterable<string>,
): ResourceItem[] {
  const excluded = new Set(excludedKinds)
  const items = Object.values(resources)
    .flat()
    .filter((item) => !item.conversationId) // workspace/global only
    .filter((item) => !excluded.has(item.kind)) // honor the blocklist
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
