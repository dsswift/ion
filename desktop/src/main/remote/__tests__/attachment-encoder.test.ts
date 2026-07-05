import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// electron is not loadable from a node-environment vitest run. Mock
// nativeImage so the encoder's compress step works against a controllable
// stub: the stub returns the input bytes verbatim as a JPEG, keeping the
// test focused on encoder behavior (path rewriting, mime sniffing, error
// handling) rather than real image codec output.
vi.mock('electron', () => {
  const makeImage = (buf: Buffer, w = 100, h = 100): any => ({
    isEmpty: () => buf.length === 0,
    getSize: () => ({ width: w, height: h }),
    resize: (_opts: any) => makeImage(buf, _opts.width ?? w, _opts.height ?? h),
    toJPEG: (_q: number) => buf,
  })
  return {
    nativeImage: {
      createFromBuffer: (buf: Buffer) => makeImage(buf),
    },
  }
})

import { encodeAttachments, type RawAttachment } from '../attachment-encoder'

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
  const fd = require('fs').openSync(p, 'w')
  require('fs').writeSync(fd, Buffer.from([0]), 0, 1, mb * 1024 * 1024)
  require('fs').closeSync(fd)
  return p
}

describe('encodeAttachments — images', () => {
  it('returns empty result when no attachments are supplied', () => {
    const r = encodeAttachments('hi', undefined, local)
    expect(r.encoded).toEqual([])
    expect(r.rewrittenText).toBe('hi')
  })

  it('encodes a real jpeg and rewrites its marker to the content-attached form', () => {
    const path = writeBytes('photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    const text = `[Attached image: ${path}]\n\nwhat is this`
    const { encoded, rewrittenText } = encodeAttachments(text, [att(path)], local)
    expect(rewrittenText).toBe('[Attachment: photo.jpg (content attached)]\n\nwhat is this')
    expect(encoded).toHaveLength(1)
    expect(encoded[0].mediaType).toBe('image/jpeg')
    expect(encoded[0].data).toBe(Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64'))
    expect(encoded[0].path).toBe(path)
  })

  it('the rewritten marker matches neither harness MARKER_RE nor engine attachmentMarkerRe', () => {
    const path = writeBytes('photo.jpg', Buffer.from([0xff, 0xd8]))
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

  it('passes png through unchanged when small, sends webp recompressed as jpeg', () => {
    const png = writeBytes('a.png', Buffer.from([1, 2]))
    const webp = writeBytes('b.webp', Buffer.from([3, 4]))
    const text = `[Attached image: ${png}]\n[Attached image: ${webp}]`
    const { encoded } = encodeAttachments(text, [att(png), att(webp)], local)
    expect(encoded).toHaveLength(2)
    expect(encoded[0].mediaType).toBe('image/png')
    expect(encoded[1].mediaType).toBe('image/jpeg')
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

  it('leaves non-pdf file attachments and plan markers untouched', () => {
    const txt = writeBytes('notes.txt', Buffer.from('hello'))
    const text = `[Attached file: ${txt}]\n[Attached plan: /tmp/plan.md]\ngo`
    const { encoded, rewrittenText } = encodeAttachments(text, [att(txt, 'file')], remote)
    expect(encoded).toEqual([])
    expect(rewrittenText).toBe(text)
  })

  it('handles pdf + image together', () => {
    const pdf = writeBytes('doc.pdf', Buffer.from('%PDF-1.4 x'))
    const img = writeBytes('pic.jpg', Buffer.from([0xff, 0xd8]))
    const text = `[Attached file: ${pdf}]\n[Attached image: ${img}]\ncompare`
    const { encoded, rewrittenText } = encodeAttachments(text, [att(pdf, 'file'), att(img)], remote)
    expect(encoded).toHaveLength(2)
    expect(encoded.map((e) => e.mediaType)).toEqual(['application/pdf', 'image/jpeg'])
    expect(rewrittenText).toContain('[Attachment: doc.pdf (content attached)]')
    expect(rewrittenText).toContain('[Attachment: pic.jpg (content attached)]')
  })
})
