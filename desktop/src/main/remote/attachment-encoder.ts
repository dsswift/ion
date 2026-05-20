import { readFileSync, statSync } from 'fs'
import { basename, extname } from 'path'
import { nativeImage } from 'electron'
import { log as _log, warn as _warn } from '../logger'
import type { ImageAttachmentPayload } from '../../shared/types'

const TAG = 'attachments'
function log(msg: string): void { _log(TAG, msg) }
function warn(msg: string): void { _warn(TAG, msg) }

// Original-file size cap. Anything larger is rejected before decode so a
// stray multi-hundred-MB photo never explodes memory on the way to resize.
const RAW_MAX_BYTES = 25 * 1024 * 1024

// Anthropic auto-downscales anything wider than 1568px on the long edge,
// so resampling client-side at this size is the largest you'd ever want
// to send. Everything past it is paid token waste.
const MAX_DIM = 1568

// Target encoded size after recompression. iOS already compresses to
// ~1 MB before upload; matching that here keeps the wire payload small,
// stays well under Anthropic's 5 MB per-image input cap, and stays under
// the engine's NDJSON line cap with room to spare.
const TARGET_BYTES = 1_000_000

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** Subset of the inbound remote attachment shape we read from. */
export interface RawAttachment {
  type: string // "image" | "file" | ...
  name: string
  path: string
}

export interface EncodeResult {
  encoded: ImageAttachmentPayload[]
  rewrittenText: string
}

/**
 * Decode → optionally downscale → JPEG-encode at decreasing quality until
 * the output fits TARGET_BYTES. Returns the encoded JPEG bytes, or null if
 * the source can't be decoded as an image.
 *
 * GIFs get sent as-is (no decode loop): nativeImage drops animation, and
 * static frames are usually small. PNG with transparency also passes
 * through unchanged at <= TARGET_BYTES, otherwise it's flattened to JPEG.
 */
function compressImage(buf: Buffer, mediaType: string): { bytes: Buffer; mediaType: string } | null {
  if (mediaType === 'image/gif') {
    return { bytes: buf, mediaType }
  }
  let img = nativeImage.createFromBuffer(buf)
  if (img.isEmpty()) return null

  const size = img.getSize()
  const longEdge = Math.max(size.width, size.height)
  if (longEdge > MAX_DIM) {
    const scale = MAX_DIM / longEdge
    img = img.resize({
      width: Math.round(size.width * scale),
      height: Math.round(size.height * scale),
      quality: 'best',
    })
  }

  // PNG passthrough when small enough — keeps transparency intact.
  if (mediaType === 'image/png' && longEdge <= MAX_DIM && buf.length <= TARGET_BYTES) {
    return { bytes: buf, mediaType: 'image/png' }
  }

  for (const q of [85, 75, 65, 55, 45, 35]) {
    const encoded = img.toJPEG(q)
    if (encoded.length <= TARGET_BYTES) {
      return { bytes: encoded, mediaType: 'image/jpeg' }
    }
  }
  // Last-resort: lowest quality we tried, even if it still exceeds the
  // target. Better to overshoot a little than to drop the image entirely.
  return { bytes: img.toJPEG(35), mediaType: 'image/jpeg' }
}

/**
 * Read each image attachment from disk, base64-encode it, and produce both:
 *   - an array of {mediaType,data,path} payloads to ride alongside the user
 *     prompt as native multimodal content, and
 *   - a rewritten prompt text in which any [Attached image: <path>] marker
 *     for an unreadable image is replaced with [image unavailable: <name>].
 *
 * Non-image attachments and successfully encoded image markers are left in
 * the text untouched — the marker doubles as a client-side display hint
 * that an image was sent at this turn.
 */
export function encodeImageAttachments(
  text: string,
  attachments: RawAttachment[] | undefined,
): EncodeResult {
  if (!attachments || attachments.length === 0) {
    return { encoded: [], rewrittenText: text }
  }

  const encoded: ImageAttachmentPayload[] = []
  let rewritten = text

  for (const a of attachments) {
    if (a.type !== 'image') continue
    const ext = extname(a.path).toLowerCase()
    const mediaType = MIME_BY_EXT[ext]

    const fail = (reason: string): void => {
      warn(`encoded skipped: ${reason} path=${a.path}`)
      const marker = `[Attached image: ${a.path}]`
      const replacement = `[image unavailable: ${basename(a.path)}]`
      // Replace only the first occurrence of this exact marker so identical
      // paths in the same prompt are handled in order.
      const idx = rewritten.indexOf(marker)
      if (idx >= 0) {
        rewritten = rewritten.slice(0, idx) + replacement + rewritten.slice(idx + marker.length)
      }
    }

    if (!mediaType) {
      fail(`unsupported image extension: ${ext || '(none)'}`)
      continue
    }

    let buf: Buffer
    try {
      const st = statSync(a.path)
      if (st.size > RAW_MAX_BYTES) {
        fail(`image too large to load: ${(st.size / (1024 * 1024)).toFixed(1)}MB > ${RAW_MAX_BYTES / (1024 * 1024)}MB`)
        continue
      }
      buf = readFileSync(a.path)
    } catch (err) {
      fail(`read failed: ${(err as Error).message}`)
      continue
    }

    const compressed = compressImage(buf, mediaType)
    if (!compressed) {
      fail(`decode failed: not a valid image`)
      continue
    }

    encoded.push({
      mediaType: compressed.mediaType,
      data: compressed.bytes.toString('base64'),
      path: a.path,
    })
    log(`encoded image: ${basename(a.path)} raw=${buf.length} sent=${compressed.bytes.length} mime=${compressed.mediaType}`)
  }

  return { encoded, rewrittenText: rewritten }
}
