import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, openSync, writeSync, closeSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { PNG } from 'pngjs'
import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js'
import { compressImage, downscaleRaster, encodeAttachments, type RawAttachment } from '../attachment-encoder'

// Real codec output on purpose. The previous version of this suite injected
// an Electron nativeImage stub, which is exactly how the server shipped with
// an image path that threw on every pasted screenshot: the tests proved the
// marker rewriting and never once ran the decoder the packaged process had.
// These fixtures are tiny real PNG / JPEG files produced by the same pure-JS
// codecs the encoder uses, so the test exercises the code path that runs.

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'attachenc-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

const writeBytes = (name: string, bytes: Buffer): string => {
  const p = join(workDir, name)
  writeFileSync(p, bytes)
  return p
}

const att = (path: string, type = 'image', name?: string): RawAttachment => ({
  type,
  path,
  name: name ?? path.split('/').pop() ?? path,
})

const local = { isRemote: false }
const remote = { isRemote: true }

/** Write a sparse file whose stat size is `mb` megabytes. */
const writeSparse = (name: string, mb: number): string => {
  const p = join(workDir, name)
  const fd = openSync(p, 'w')
  writeSync(fd, Buffer.from([0]), 0, 1, mb * 1024 * 1024)
  closeSync(fd)
  return p
}

/** Solid-colour RGBA raster. */
function raster(width: number, height: number, rgba: [number, number, number, number]): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(width * height * 4)
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i)
  return { width, height, data }
}

function pngBytes(width: number, height: number, rgba: [number, number, number, number] = [200, 30, 30, 255]): Buffer {
  const png = new PNG({ width, height })
  png.data = Buffer.from(raster(width, height, rgba).data)
  return PNG.sync.write(png)
}

function jpegBytes(width: number, height: number, quality = 90): Buffer {
  return encodeJpeg(raster(width, height, [30, 30, 200, 255]), quality).data
}

describe('compressImage', () => {
  it('passes a small PNG through untouched, transparency and all', () => {
    const bytes = pngBytes(8, 8, [0, 0, 0, 0])
    const out = compressImage(bytes, 'image/png')
    expect(out).toEqual({ bytes, mediaType: 'image/png' })
  })

  it('downscales an oversized PNG to the long-edge cap and re-encodes it as JPEG', () => {
    const out = compressImage(pngBytes(3136, 200), 'image/png')
    if ('error' in out) throw new Error(out.error)
    expect(out.mediaType).toBe('image/jpeg')
    expect(out.width).toBe(1568)
    expect(out.height).toBe(100)
    const decoded = decodeJpeg(out.bytes, { useTArray: true })
    expect([decoded.width, decoded.height]).toEqual([1568, 100])
  })

  it('re-encodes a JPEG within the dimension cap without resizing', () => {
    const out = compressImage(jpegBytes(64, 48), 'image/jpeg')
    if ('error' in out) throw new Error(out.error)
    expect(out.mediaType).toBe('image/jpeg')
    expect([out.width, out.height]).toEqual([64, 48])
  })

  it('names the decoder failure for bytes that are not an image', () => {
    const out = compressImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), 'image/jpeg')
    expect(out).toHaveProperty('error')
    expect((out as { error: string }).error).toMatch(/^decode failed: /)
  })

  it('passes GIF and WebP through when small and refuses them when over the target', () => {
    const small = Buffer.from('RIFF....WEBP')
    expect(compressImage(small, 'image/webp')).toEqual({ bytes: small, mediaType: 'image/webp' })
    expect(compressImage(small, 'image/gif')).toEqual({ bytes: small, mediaType: 'image/gif' })
    const big = Buffer.alloc(1_000_001)
    const out = compressImage(big, 'image/webp')
    expect((out as { error: string }).error).toMatch(/cannot be recompressed/)
  })
})

describe('downscaleRaster', () => {
  it('averages the source pixels each destination pixel covers', () => {
    // 4x2 source: left half red, right half blue -> 2x1 keeps the halves.
    const src = { width: 4, height: 2, data: new Uint8Array(4 * 2 * 4) }
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 4; x++) {
        const i = (y * 4 + x) * 4
        src.data.set(x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], i)
      }
    }
    const out = downscaleRaster(src, 2, 1)
    expect(Array.from(out.data)).toEqual([255, 0, 0, 255, 0, 0, 255, 255])
  })
})

describe('encodeAttachments — images', () => {
  it('returns empty result when no attachments are supplied', () => {
    const r = encodeAttachments('hi', undefined, local)
    expect(r.encoded).toEqual([])
    expect(r.rewrittenText).toBe('hi')
  })

  it('encodes a real jpeg and rewrites its marker to the content-attached form', () => {
    const original = jpegBytes(16, 16)
    const path = writeBytes('photo.jpg', original)
    const text = `[Attached image: ${path}]\n\nwhat is this`
    const { encoded, rewrittenText } = encodeAttachments(text, [att(path)], local)
    expect(rewrittenText).toBe('[Attachment: photo.jpg (content attached)]\n\nwhat is this')
    expect(encoded).toHaveLength(1)
    expect(encoded[0].mediaType).toBe('image/jpeg')
    const decoded = decodeJpeg(Buffer.from(encoded[0].data, 'base64'), { useTArray: true })
    expect([decoded.width, decoded.height]).toEqual([16, 16])
    expect(encoded[0].path).toBe(path)
    // The hash identifies the ORIGINAL bytes the operator attached, not the
    // recompressed payload -- it is how the persisted image is matched later.
    expect(encoded[0].contentHash).toBe(createHash('sha256').update(original).digest('hex'))
  })

  it('the rewritten marker matches neither harness MARKER_RE nor engine attachmentMarkerRe', () => {
    const path = writeBytes('photo.jpg', jpegBytes(4, 4))
    const { rewrittenText } = encodeAttachments(`[Attached image: ${path}]`, [att(path)], remote)
    // Same grammar as harness-ts attachmentResolver MARKER_RE and the engine's
    // attachmentMarkerRe: a rewritten marker must never re-match either.
    const markerRe = /\[Attached (file|image|plan): ([^\]]+)\]/g
    expect(rewrittenText.match(markerRe)).toBeNull()
  })

  it('rewrites the marker for a missing file and omits it from encoded', () => {
    const path = join(workDir, 'gone.png')
    const text = `[Attached image: ${path}]\n\nplease describe`
    const { encoded, rewrittenText } = encodeAttachments(text, [att(path)], local)
    expect(encoded).toEqual([])
    expect(rewrittenText).toBe('[image unavailable: gone.png]\n\nplease describe')
  })

  it('rewrites the marker for bytes the decoder rejects', () => {
    const path = writeBytes('broken.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const { encoded, rewrittenText } = encodeAttachments(`[Attached image: ${path}]`, [att(path)], local)
    expect(encoded).toEqual([])
    expect(rewrittenText).toBe('[image unavailable: broken.png]')
  })

  it('rewrites the marker for an unsupported extension', () => {
    const path = writeBytes('thing.bmp', Buffer.from([1, 2, 3]))
    const text = `[Attached image: ${path}]`
    const { encoded, rewrittenText } = encodeAttachments(text, [att(path)], local)
    expect(encoded).toEqual([])
    expect(rewrittenText).toBe('[image unavailable: thing.bmp]')
  })

  it('rejects images larger than the raw cap by rewriting the marker', () => {
    const big = writeSparse('huge.jpg', 26)
    const text = `[Attached image: ${big}]`
    const { encoded, rewrittenText } = encodeAttachments(text, [att(big)], local)
    expect(encoded).toEqual([])
    expect(rewrittenText).toBe('[image unavailable: huge.jpg]')
  })

  it('passes a small png and a small webp through with their own media types', () => {
    const png = writeBytes('a.png', pngBytes(4, 4))
    const webp = writeBytes('b.webp', Buffer.from('RIFF....WEBP'))
    const text = `[Attached image: ${png}]\n[Attached image: ${webp}]`
    const { encoded } = encodeAttachments(text, [att(png), att(webp)], local)
    expect(encoded).toHaveLength(2)
    expect(encoded[0].mediaType).toBe('image/png')
    expect(encoded[1].mediaType).toBe('image/webp')
  })

  it('does not pollute the directory when given empty input', () => {
    mkdirSync(join(workDir, 'subdir'))
    const r = encodeAttachments('', [], local)
    expect(r.encoded).toEqual([])
    expect(r.rewrittenText).toBe('')
  })
})

describe('encodeAttachments — PDFs', () => {
  it('encodes a pdf verbatim (no recompression) and rewrites its marker', () => {
    const bytes = Buffer.from('%PDF-1.4 test content')
    const path = writeBytes('report.pdf', bytes)
    const text = `[Attached file: ${path}]\n\nsummarize`
    const { encoded, rewrittenText } = encodeAttachments(text, [att(path, 'file')], remote)
    expect(encoded).toHaveLength(1)
    expect(encoded[0].mediaType).toBe('application/pdf')
    expect(encoded[0].data).toBe(bytes.toString('base64'))
    expect(encoded[0].path).toBe(path)
    expect(rewrittenText).toBe('[Attachment: report.pdf (content attached)]\n\nsummarize')
  })

  it('over-cap pdf: keeps the original marker locally (Read/disk fallback)', () => {
    const big = writeSparse('big.pdf', 25)
    const text = `[Attached file: ${big}]`
    const { encoded, rewrittenText } = encodeAttachments(text, [att(big, 'file')], local)
    expect(encoded).toEqual([])
    expect(rewrittenText).toBe(text)
  })

  it('over-cap pdf: rewrites to an honest note remotely', () => {
    const big = writeSparse('big.pdf', 25)
    const text = `[Attached file: ${big}]`
    const { encoded, rewrittenText } = encodeAttachments(text, [att(big, 'file')], remote)
    expect(encoded).toEqual([])
    expect(rewrittenText).toContain('[file unavailable: big.pdf -- too large to send (25MB)]')
  })

  it('enforces the cumulative prompt budget across multiple pdfs', () => {
    const a = writeSparse('a.pdf', 20)
    const b = writeSparse('b.pdf', 20)
    const text = `[Attached file: ${a}]\n[Attached file: ${b}]`
    const { encoded, rewrittenText } = encodeAttachments(text, [att(a, 'file'), att(b, 'file')], remote)
    expect(encoded).toHaveLength(1)
    expect(encoded[0].path).toBe(a)
    expect(rewrittenText).toContain('[Attachment: a.pdf (content attached)]')
    expect(rewrittenText).toContain('[file unavailable: b.pdf -- attachment budget for this message exceeded]')
  })

  it('missing pdf: keeps marker locally, rewrites remotely', () => {
    const gone = join(workDir, 'gone.pdf')
    const text = `[Attached file: ${gone}]`
    expect(encodeAttachments(text, [att(gone, 'file')], local).rewrittenText).toBe(text)
    expect(encodeAttachments(text, [att(gone, 'file')], remote).rewrittenText).toBe('[file unavailable: gone.pdf]')
  })

  it('rewrites non-pdf file markers to unavailable on remote, keeps locally (#271 Gap 2)', () => {
    const txt = writeBytes('notes.txt', Buffer.from('hello'))
    const text = `[Attached file: ${txt}]\ngo`
    // Remote: model needs an honest signal that the file is unavailable.
    const { encoded: remEnc, rewrittenText: remText } = encodeAttachments(text, [att(txt, 'file')], remote)
    expect(remEnc).toEqual([])
    expect(remText).toContain('[File unavailable: notes.txt (remote attachment unsupported)]')
    expect(remText).not.toContain('[Attached file:')
    // Local: keep original marker so the engine can read the path from disk.
    const { encoded: locEnc, rewrittenText: locText } = encodeAttachments(text, [att(txt, 'file')], local)
    expect(locEnc).toEqual([])
    expect(locText).toBe(text)
  })

  it('plan markers are always left untouched regardless of remote flag', () => {
    const text = `[Attached plan: /tmp/plan.md]\ngo`
    expect(encodeAttachments(text, [], remote).rewrittenText).toBe(text)
    expect(encodeAttachments(text, [], local).rewrittenText).toBe(text)
  })

  it('handles pdf + image together', () => {
    const pdf = writeBytes('doc.pdf', Buffer.from('%PDF-1.4 x'))
    const img = writeBytes('pic.jpg', jpegBytes(4, 4))
    const text = `[Attached file: ${pdf}]\n[Attached image: ${img}]\ncompare`
    const { encoded, rewrittenText } = encodeAttachments(text, [att(pdf, 'file'), att(img)], remote)
    expect(encoded).toHaveLength(2)
    expect(encoded.map((e) => e.mediaType)).toEqual(['application/pdf', 'image/jpeg'])
    expect(rewrittenText).toContain('[Attachment: doc.pdf (content attached)]')
    expect(rewrittenText).toContain('[Attachment: pic.jpg (content attached)]')
  })
})
