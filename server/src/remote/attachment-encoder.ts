import { createHash } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { basename, extname } from 'path'
import { PNG } from 'pngjs'
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js'
import { log as _log, warn as _warn } from '../logger'
import type { ImageAttachmentPayload } from '@ion/shared/types'

// ---------------------------------------------------------------------------
// Image codecs.
//
// This module runs in the Studio server, which is a plain Node process: the
// desktop spawns it with ELECTRON_RUN_AS_NODE=1, a container runs it under
// node directly, and vitest runs it under node. None of those has Electron's
// `nativeImage`, so every codec here is pure JavaScript (pngjs, jpeg-js) and
// is bundled into dist/main.js by server/scripts/build.mjs like any other
// dependency. The first packaged desktop whose server reached for
// `require('electron')` failed EVERY prompt that carried a pasted image: the
// require threw inside the prompt pipeline, the store marked the tab failed,
// and nothing was logged.
//
// What the pure-JS path can and cannot do:
//   - PNG and JPEG decode, downscale, and JPEG re-encode -- the same
//     pipeline the Electron version ran.
//   - GIF and WebP have no pure-JS decoder here. Both are formats the model
//     accepts natively, so they pass through unchanged when already within
//     TARGET_BYTES and are refused (with an honest marker) when larger.
// ---------------------------------------------------------------------------

/** A decoded image: 8-bit RGBA, row-major, 4 bytes per pixel. */
interface Raster {
  width: number
  height: number
  data: Uint8Array
}

const TAG = 'attachments'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

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
 * Width and height from a PNG's IHDR chunk, or null when the bytes do not
 * start like a PNG. Reading the header is what lets a small PNG pass through
 * without a full decode; a malformed header falls through to the decoder,
 * which reports the real error.
 */
function pngDimensions(buf: Buffer): { width: number; height: number } | null {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE)) return null
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** Decode PNG or JPEG bytes to RGBA, or return the decoder's error text. */
function decodeRaster(buf: Buffer, mediaType: string): Raster | { error: string } {
  try {
    if (mediaType === 'image/png') {
      const png = PNG.sync.read(buf)
      return { width: png.width, height: png.height, data: png.data }
    }
    if (mediaType === 'image/jpeg') {
      // RAW_MAX_BYTES caps the file, not the pixel count; a 25MB JPEG can
      // still be a 100MP scan. The decoder's own limits turn that into an
      // error instead of an out-of-memory crash of the whole server.
      return decodeJpeg(buf, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 200, maxMemoryUsageInMB: 1024 })
    }
    return { error: `no decoder for ${mediaType}` }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

/**
 * Box-filter downscale. Every destination pixel averages the source pixels
 * it covers, which is the right filter for the only direction this module
 * resizes in (down) and needs no dependency. Alpha is averaged like a
 * channel; the JPEG encoder drops it anyway.
 */
export function downscaleRaster(src: Raster, width: number, height: number): Raster {
  const out = new Uint8Array(width * height * 4)
  const xRatio = src.width / width
  const yRatio = src.height / height
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * yRatio)
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * yRatio)))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * xRatio)
      const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * xRatio)))
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * src.width + x0) * 4
        for (let sx = x0; sx < x1; sx++, i += 4) {
          r += src.data[i]
          g += src.data[i + 1]
          b += src.data[i + 2]
          a += src.data[i + 3]
        }
      }
      const n = (y1 - y0) * (x1 - x0)
      const o = (y * width + x) * 4
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
      out[o + 3] = Math.round(a / n)
    }
  }
  return { width, height, data: out }
}

/**
 * Decode → optionally downscale → JPEG-encode at decreasing quality until
 * the output fits TARGET_BYTES. Returns the encoded bytes, or an error naming
 * why the image could not be prepared.
 *
 * GIF and WebP are sent as-is when they already fit TARGET_BYTES (the model
 * decodes both natively; there is no pure-JS decoder for them here). PNG with
 * transparency also passes through unchanged at <= TARGET_BYTES, otherwise
 * it is flattened to JPEG.
 */
export function compressImage(buf: Buffer, mediaType: string): { bytes: Buffer; mediaType: string; width?: number; height?: number } | { error: string } {
  if (mediaType === 'image/gif' || mediaType === 'image/webp') {
    if (buf.length <= TARGET_BYTES) return { bytes: buf, mediaType }
    return { error: `${mediaType} is ${(buf.length / (1024 * 1024)).toFixed(1)}MB and cannot be recompressed here (no pure-JS decoder); keep it under ${TARGET_BYTES / 1_000_000}MB` }
  }

  // PNG passthrough when small enough -- keeps transparency intact, and skips
  // the decode entirely because the header already carries the dimensions.
  if (mediaType === 'image/png' && buf.length <= TARGET_BYTES) {
    const dims = pngDimensions(buf)
    if (dims && Math.max(dims.width, dims.height) <= MAX_DIM) {
      return { bytes: buf, mediaType: 'image/png' }
    }
  }

  const decoded = decodeRaster(buf, mediaType)
  if ('error' in decoded) return { error: `decode failed: ${decoded.error}` }
  let img: Raster = decoded
  if (img.width === 0 || img.height === 0) return { error: 'decode failed: empty image' }

  const longEdge = Math.max(img.width, img.height)
  if (longEdge > MAX_DIM) {
    const scale = MAX_DIM / longEdge
    img = downscaleRaster(img, Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)))
  }

  for (const q of [85, 75, 65, 55, 45, 35]) {
    const encoded = encodeJpeg({ width: img.width, height: img.height, data: img.data }, q).data
    if (encoded.length <= TARGET_BYTES) {
      return { bytes: encoded, mediaType: 'image/jpeg', width: img.width, height: img.height }
    }
  }
  // Last-resort: lowest quality we tried, even if it still exceeds the
  // target. Better to overshoot a little than to drop the image entirely.
  return { bytes: encodeJpeg({ width: img.width, height: img.height, data: img.data }, 35).data, mediaType: 'image/jpeg', width: img.width, height: img.height }
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
    if (a.type !== 'image' && !isPdf) {
      // Non-PDF file attachment: can't encode as a content block. Locally the
      // engine can read the path from disk (Read-tool fallback, #789), so keep
      // the marker. Remotely the client-local path is unreachable on the engine
      // host — rewrite to an explicit "unavailable" note so the model gets an
      // honest signal instead of a dead marker (#271).
      if (opts.isRemote) {
        const marker = `[Attached ${a.type}: ${a.path}]`
        warn('encode_skipped', { reason: 'non-pdf file on remote engine', path: a.path })
        rewritten = replaceMarker(rewritten, marker, `[File unavailable: ${name} (remote attachment unsupported)]`)
      }
      continue
    }

    const marker = `[Attached ${a.type}: ${a.path}]`
    const kindNoun = a.type === 'image' ? 'image' : 'file'
    const fail = (reason: string, note: string): void => {
      warn('encode_skipped', { reason, path: a.path })
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
      log('encoded_pdf', { name, raw_bytes: buf.length })
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
    if ('error' in compressed) {
      fail(compressed.error, '')
      continue
    }
    totalBytes += compressed.bytes.length
    encoded.push({
      contentHash: createHash('sha256').update(buf).digest('hex'),
      mediaType: compressed.mediaType,
      data: compressed.bytes.toString('base64'),
      path: a.path,
    })
    rewritten = replaceMarker(rewritten, marker, `[Attachment: ${name} (content attached)]`)
    log('encoded_image', { name, raw_bytes: buf.length, sent_bytes: compressed.bytes.length, mime: compressed.mediaType, width: compressed.width ?? '', height: compressed.height ?? '', source_mime: mediaType })
  }

  return { encoded, rewrittenText: rewritten }
}
