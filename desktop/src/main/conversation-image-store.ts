/**
 * conversation-image-store.ts
 *
 * TypeScript mirror of the engine's content-addressed image saver
 * (engine/internal/conversation/image_store.go → SaveImageToConversation).
 *
 * The desktop-side conversation loaders that fall back to reading conversation
 * files directly from disk (when the engine RPC is unavailable) must replay
 * persisted tool-result image blocks the same way the engine does on reload:
 * decode the inline base64, write it to a content-addressed file, and reference
 * the ON-DISK PATH (never base64) in the message attachment.
 *
 * Content-addressing (filename = sha256 of the decoded bytes) is load-bearing:
 * the engine's live emit-time save and every reload-time save — engine or
 * desktop — converge on the exact same file for the same image bytes. So a
 * desktop fallback save resolves to the identical file the engine wrote, never
 * a duplicate, and only writes when the file is missing (e.g. pruned).
 */

import { createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { log as _log } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void { _log('main', msg, fields) }

/**
 * MIME media type → file extension, mirroring the engine's imageExtByMediaType.
 * Unknown types fall back to ".bin" so a save never fails on an unrecognized
 * type — the bytes are still preserved and the path is still emitted.
 */
const IMAGE_EXT_BY_MEDIA_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
}

/** Attachment shape carried on a reloaded tool/assistant message row. */
export interface ImageAttachment {
  id: string
  type: 'image'
  name: string
  path: string
  mimeType: string
}

/**
 * Decode base64 image data and write it to
 * {convDir}/{convId}/images/{sha256(bytes)}.{ext}, returning the absolute file
 * path. Idempotent: a save that finds the content-addressed file already
 * present skips the write and returns the existing path — this is what makes
 * the engine's live save and the desktop reload save converge on one file.
 *
 * `convDir` is the conversations ROOT (defaults to ~/.ion/conversations, matching
 * the engine). Returns null when the inputs are empty or the save fails (the
 * image is dropped rather than emitting a dangling path).
 */
export function saveImageToConversation(
  convId: string,
  mediaType: string,
  base64Data: string,
  convDir: string = join(homedir(), '.ion', 'conversations'),
): string | null {
  if (!convId || !base64Data) return null
  try {
    const data = Buffer.from(base64Data, 'base64')
    if (data.length === 0) {
      log('conversation_image_store: empty decoded image; dropping', { conversation_id: convId, media_type: mediaType })
      return null
    }
    const ext = IMAGE_EXT_BY_MEDIA_TYPE[mediaType] || 'bin'
    const imagesDir = join(convDir, convId, 'images')
    mkdirSync(imagesDir, { recursive: true })

    const sum = createHash('sha256').update(data).digest('hex')
    const path = join(imagesDir, `${sum}.${ext}`)

    // Content-addressed: same bytes → same name. Skip the write when present.
    if (existsSync(path)) {
      log('conversation_image_store: image already present (content-addressed); skipping write', { conversation_id: convId, path })
      return path
    }

    writeFileSync(path, data)
    log('conversation_image_store: image saved', { conversation_id: convId, media_type: mediaType, path, bytes: data.length })
    return path
  } catch (err) {
    log('conversation_image_store: save failed; dropping image', { conversation_id: convId, media_type: mediaType, error: (err as Error).message })
    return null
  }
}

/**
 * Turn a persisted "image" content block into an ImageAttachment for historical
 * reload. Mirrors the engine's imageAttachmentFromBlock: the block stores the
 * image inline as base64 in `source.data` (media type in `source.media_type`);
 * the returned attachment carries the re-derived on-disk PATH, never base64.
 * Returns null when the block has no image source or the save fails.
 */
export function imageAttachmentFromBlock(
  convId: string,
  block: any,
  convDir?: string,
): ImageAttachment | null {
  const src = block?.source
  if (!src || !src.data) return null
  const mediaType: string = src.media_type || ''
  const path = saveImageToConversation(convId, mediaType, src.data, convDir)
  if (!path) return null
  const name = path.split('/').pop() || path
  return { id: 'img:' + path, type: 'image', name, path, mimeType: mediaType }
}
