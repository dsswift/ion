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

// Engine-side cap for a single inlined document (mirrors the engine's
// maxInlineAttachmentBytes). PDFs are sent verbatim -- never recompressed --
// so anything over this is refused client-side with an honest fallback.
const PDF_MAX_BYTES = 24 * 1024 * 1024

// Cumulative raw-bytes budget across all attachments in one prompt. Base64
// inflates by ~4/3, so 36MB raw ~= 48MB encoded -- comfortably under the
// engine's 64MB NDJSON line cap including envelope.
const PROMPT_TOTAL_MAX_BYTES = 36 * 1024 * 1024

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

export interface EncodeOptions {
  /**
   * Whether the engine runs on a different host. Controls the fallback for
   * attachments we cannot inline: locally the original marker survives (the
   * engine can still read the path from disk -- #789); remotely the marker is
   * rewritten to an honest "unavailable" note, because a client-local path is
   * meaningless on the engine host.
   */
  isRemote: boolean
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

/** Replace the first occurrence of `marker` in `text` with `replacement`. */
function replaceMarker(text: string, marker: string, replacement: string): string {
  const idx = text.indexOf(marker)
  if (idx < 0) return text
  return text.slice(0, idx) + replacement + text.slice(idx + marker.length)
}

/**
 * Read each attachment from disk, base64-encode it, and produce both:
 *   - an array of {mediaType,data,path} payloads to ride alongside the user
 *     prompt as native multimodal content (image blocks for images, document
 *     blocks for PDFs -- the engine keys on mediaType), and
 *   - a rewritten prompt text.
 *
 * Marker rewriting is the contract that keeps remote engines fast and honest:
 *   - successfully encoded attachments get `[Attachment: <name> (content
 *     attached)]` -- a form that matches NEITHER the harness resolver's
 *     MARKER_RE nor the engine's attachmentMarkerRe, so no component ever
 *     polls or Reads a client-local path for content that already rode the
 *     wire (previously every remote image/PDF burned a ~15s resolver timeout);
 *   - failures fall back per EncodeOptions.isRemote (see above).
 *
 * Non-image, non-PDF `file` attachments keep their original marker: locally
 * the engine's Read fallback handles them; remotely they are a known gap
 * (the model will say it cannot access the file).
 */
export function encodeAttachments(
  text: string,
  attachments: RawAttachment[] | undefined,
  opts: EncodeOptions,
): EncodeResult {
  if (!attachments || attachments.length === 0) {
    return { encoded: [], rewrittenText: text }
  }

  const encoded: ImageAttachmentPayload[] = []
  let rewritten = text
  let totalBytes = 0

  for (const a of attachments) {
    const name = basename(a.path)
    const ext = extname(a.path).toLowerCase()
    const isPdf = a.type === 'file' && ext === '.pdf'
    if (a.type !== 'image' && !isPdf) continue

    const marker = `[Attached ${a.type}: ${a.path}]`
    const kindNoun = a.type === 'image' ? 'image' : 'file'
    const fail = (reason: string, note: string): void => {
      warn(`encode skipped: ${reason} path=${a.path}`)
      if (opts.isRemote || a.type === 'image') {
        // Remote: the path cannot be read on the engine host, so an honest
        // note beats a dead marker. Images also always get the note (their
        // markers were never Read-fallback material).
        rewritten = replaceMarker(rewritten, marker, `[${kindNoun} unavailable: ${name}${note}]`)
      }
      // Local non-image: keep the original marker -- the engine reads the
      // path from disk (#789) or the model falls back to the Read tool.
    }

    const srcPath = a.path
    let size: number
    try {
      size = statSync(srcPath).size
    } catch (err) {
      fail(`stat failed: ${(err as Error).message}`, '')
      continue
    }

    if (isPdf) {
      if (size > PDF_MAX_BYTES) {
        fail(`pdf too large: ${(size / (1024 * 1024)).toFixed(1)}MB`, ` -- too large to send (${(size / (1024 * 1024)).toFixed(0)}MB)`)
        continue
      }
      if (totalBytes + size > PROMPT_TOTAL_MAX_BYTES) {
        fail(`prompt attachment budget exceeded`, ' -- attachment budget for this message exceeded')
        continue
      }
      let buf: Buffer
      try {
        buf = readFileSync(srcPath)
      } catch (err) {
        fail(`read failed: ${(err as Error).message}`, '')
        continue
      }
      totalBytes += buf.length
      encoded.push({ mediaType: 'application/pdf', data: buf.toString('base64'), path: a.path })
      rewritten = replaceMarker(rewritten, marker, `[Attachment: ${name} (content attached)]`)
      log(`encoded pdf: ${name} raw=${buf.length}`)
      continue
    }

    // Images: existing compress pipeline, unchanged.
    const mediaType = MIME_BY_EXT[ext]
    if (!mediaType) {
      fail(`unsupported image extension: ${ext || '(none)'}`, '')
      continue
    }
    if (size > RAW_MAX_BYTES) {
      fail(`image too large to load: ${(size / (1024 * 1024)).toFixed(1)}MB > ${RAW_MAX_BYTES / (1024 * 1024)}MB`, '')
      continue
    }
    let buf: Buffer
    try {
      buf = readFileSync(srcPath)
    } catch (err) {
      fail(`read failed: ${(err as Error).message}`, '')
      continue
    }
    const compressed = compressImage(buf, mediaType)
    if (!compressed) {
      fail(`decode failed: not a valid image`, '')
      continue
    }
    totalBytes += compressed.bytes.length
    encoded.push({
      mediaType: compressed.mediaType,
      data: compressed.bytes.toString('base64'),
      path: a.path,
    })
    rewritten = replaceMarker(rewritten, marker, `[Attachment: ${name} (content attached)]`)
    log(`encoded image: ${name} raw=${buf.length} sent=${compressed.bytes.length} mime=${compressed.mediaType}`)
  }

  return { encoded, rewrittenText: rewritten }
}
