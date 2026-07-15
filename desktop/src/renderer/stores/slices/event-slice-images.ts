/**
 * event-slice-images — image-attachment materialization for engine-generated
 * images (tool-result and provider-generated).
 *
 * The engine saves image bytes to disk under the conversation's images/
 * directory and emits an `image_content` NormalizedEvent per image carrying the
 * FILE PATH (never base64). Source is 'tool' (with a toolId) or 'provider'
 * (no toolId). This module turns that event into a FileAttachment on the right
 * message so the existing image-rendering path (deriveMessageImages /
 * InlineMessageImages, which loads the file via useImageDataUrl) renders it
 * inline, and the attachments panel (parseAttachmentsFromMessages) surfaces it.
 *
 * Extracted from event-slice.ts to keep that reducer file lean.
 */

import type { Message, FileAttachment } from '../../../shared/types'
import { nextMsgId } from '../session-store-helpers'

type ImageContentEvent = Extract<
  import('../../../shared/types-events').NormalizedEvent,
  { type: 'image_content' }
>

/** Build a FileAttachment for an engine-saved image file path. */
function imageAttachment(path: string, mediaType: string): FileAttachment {
  const name = path.includes('/') ? path.split('/').pop()! : path
  return { id: `img:${path}`, type: 'image', name, path, mimeType: mediaType }
}

/** True when `attachments` already references this file path (dedup guard). */
function hasImagePath(attachments: import('../../../shared/types').Attachment[] | undefined, path: string): boolean {
  return !!attachments?.some((a) => (a as { path?: string }).path === path)
}

/**
 * Return a new messages array with the image from `event` attached to the
 * correct message:
 *
 *  - source 'tool' (toolId set): the matching `role: 'tool'` message.
 *  - source 'provider' (or no toolId): the most recent `role: 'assistant'`
 *    message; if none exists yet, a new assistant message (empty content)
 *    is appended to carry the image.
 *
 * Dedups by file path so a duplicate event (or the parallel tool_result.images
 * field) never attaches the same image twice. When the target message can't be
 * found for a tool image, the array is returned unchanged.
 */
export function attachImageToMessages(messages: Message[], event: ImageContentEvent): Message[] {
  const att = imageAttachment(event.path, event.mediaType)

  if (event.source === 'tool' && event.toolId) {
    const idx = findLastIndex(messages, (m) => m.role === 'tool' && m.toolId === event.toolId)
    if (idx < 0) return messages
    const target = messages[idx]
    if (hasImagePath(target.attachments, event.path)) return messages
    const next = [...messages]
    next[idx] = { ...target, attachments: [...(target.attachments ?? []), att] }
    return next
  }

  // Provider-generated (or tool image with no toolId): attach to the last
  // assistant message, creating one if the run has produced none yet.
  const idx = findLastIndex(messages, (m) => m.role === 'assistant')
  if (idx >= 0) {
    const target = messages[idx]
    if (hasImagePath(target.attachments, event.path)) return messages
    const next = [...messages]
    next[idx] = { ...target, attachments: [...(target.attachments ?? []), att] }
    return next
  }
  return [
    ...messages,
    { id: nextMsgId(), role: 'assistant' as const, content: '', attachments: [att], timestamp: Date.now() },
  ]
}

/** Array.prototype.findLastIndex shim (target lib may predate ES2023). */
function findLastIndex<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i
  }
  return -1
}
