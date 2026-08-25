/**
 * Pure mapping from a conversation-scoped resource to a tab-attachment entry.
 *
 * Conversation-scoped resources (of ANY extension-declared kind) are surfaced
 * in the iOS attachments sheet. The desktop encodes them generically — type
 * is always `'resource'` (never a hardcoded kind like `'briefing'`), the real
 * kind rides along in `kind`, producer rides along in `producer`, and the path
 * is `resource:<identity>` so iOS can look the item up without collision.
 *
 * NOTE: the live extraction in `handleLoadAttachments` runs inside a renderer
 * `executeJavaScript` string and cannot import this module. This function is
 * the single source of truth for the entry SHAPE and is unit-tested; the
 * injected JS must produce the identical object. Keep them in sync.
 */
import { resourceIdentity } from '../../../shared/resource-identity'

export interface ResourceLike {
  id: string
  kind?: string
  producer?: string
  title?: string
  conversationId?: string
}

export interface TabAttachmentEntryShape {
  type: 'resource'
  kind: string
  producer?: string
  name: string
  path: string
}

export function resourceToAttachmentEntry(item: ResourceLike): TabAttachmentEntryShape {
  return {
    type: 'resource',
    kind: item.kind || '',
    producer: item.producer,
    name: item.title || item.kind || 'Resource',
    path: `resource:${resourceIdentity(item)}`,
  }
}
