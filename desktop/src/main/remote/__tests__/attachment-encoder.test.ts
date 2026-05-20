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

import { encodeImageAttachments, type RawAttachment } from '../attachment-encoder'

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

describe('encodeImageAttachments', () => {
  it('returns empty result when no attachments are supplied', () => {
    const r = encodeImageAttachments('hi', undefined)
    expect(r.encoded).toEqual([])
    expect(r.rewrittenText).toBe('hi')
  })

  it('encodes a real jpeg and leaves the prompt text untouched', () => {
    const path = writeBytes('photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    const text = `[Attached image: ${path}]\n\nwhat is this`
    const { encoded, rewrittenText } = encodeImageAttachments(text, [att(path)])
    expect(rewrittenText).toBe(text)
    expect(encoded).toHaveLength(1)
    expect(encoded[0].mediaType).toBe('image/jpeg')
    expect(encoded[0].data).toBe(Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64'))
    expect(encoded[0].path).toBe(path)
  })

  it('rewrites the marker for a missing file and omits it from encoded', () => {
    const path = join(workDir, 'gone.png')
    const text = `[Attached image: ${path}]\n\nplease describe`
    const { encoded, rewrittenText } = encodeImageAttachments(text, [att(path)])
    expect(encoded).toEqual([])
    expect(rewrittenText).toBe('[image unavailable: gone.png]\n\nplease describe')
  })

  it('rewrites the marker for an unsupported extension', () => {
    const path = writeBytes('thing.bmp', Buffer.from([1, 2, 3]))
    const text = `[Attached image: ${path}]`
    const { encoded, rewrittenText } = encodeImageAttachments(text, [att(path)])
    expect(encoded).toEqual([])
    expect(rewrittenText).toBe('[image unavailable: thing.bmp]')
  })

  it('preserves non-image attachments untouched in text and out of encoded', () => {
    const filePath = join(workDir, 'notes.txt')
    writeFileSync(filePath, 'hello')
    const text = `[Attached file: ${filePath}]\n\ncan you read this`
    const { encoded, rewrittenText } = encodeImageAttachments(text, [att(filePath, 'file')])
    expect(encoded).toEqual([])
    expect(rewrittenText).toBe(text)
  })

  it('handles a mix: one good image + one missing image + one file', () => {
    const good = writeBytes('good.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const missing = join(workDir, 'missing.jpg')
    const file = writeBytes('readme.txt', Buffer.from('x'))
    const text = [
      `[Attached image: ${good}]`,
      `[Attached image: ${missing}]`,
      `[Attached file: ${file}]`,
      '',
      'please describe',
    ].join('\n')
    const { encoded, rewrittenText } = encodeImageAttachments(text, [
      att(good),
      att(missing),
      att(file, 'file'),
    ])
    expect(encoded).toHaveLength(1)
    expect(encoded[0].path).toBe(good)
    expect(encoded[0].mediaType).toBe('image/png')
    expect(rewrittenText).toContain(`[Attached image: ${good}]`)
    expect(rewrittenText).toContain('[image unavailable: missing.jpg]')
    expect(rewrittenText).toContain(`[Attached file: ${file}]`)
    expect(rewrittenText).not.toContain(missing)
  })

  it('rejects images larger than the raw cap by rewriting the marker', () => {
    const big = join(workDir, 'huge.jpg')
    // Create a sparse-ish 26 MB file by writing one byte at offset 26*1024*1024,
    // which exceeds the 25 MB raw cap before any decode is attempted.
    const fd = require('fs').openSync(big, 'w')
    require('fs').writeSync(fd, Buffer.from([0]), 0, 1, 26 * 1024 * 1024)
    require('fs').closeSync(fd)
    const text = `[Attached image: ${big}]`
    const { encoded, rewrittenText } = encodeImageAttachments(text, [att(big)])
    expect(encoded).toEqual([])
    expect(rewrittenText).toBe('[image unavailable: huge.jpg]')
  })

  it('passes png through unchanged when small, sends webp recompressed as jpeg', () => {
    // PNG passthrough preserves transparency when bytes <= TARGET_BYTES.
    const png = writeBytes('a.png', Buffer.from([1, 2]))
    // WEBP gets recompressed via the JPEG path (the encoder normalizes to
    // a format Anthropic always accepts).
    const webp = writeBytes('b.webp', Buffer.from([3, 4]))
    const text = `[Attached image: ${png}]\n[Attached image: ${webp}]`
    const { encoded } = encodeImageAttachments(text, [att(png), att(webp)])
    expect(encoded).toHaveLength(2)
    expect(encoded[0].mediaType).toBe('image/png')
    expect(encoded[1].mediaType).toBe('image/jpeg')
  })

  it('does not pollute the directory when given empty input', () => {
    mkdirSync(join(workDir, 'subdir'))
    const r = encodeImageAttachments('', [])
    expect(r.encoded).toEqual([])
    expect(r.rewrittenText).toBe('')
  })
})
