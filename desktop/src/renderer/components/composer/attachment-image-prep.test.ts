// @vitest-environment jsdom
/**
 * A photo is shrunk in the browser to the targets the server's encoder uses
 * (`@ion/shared/attachment-image-targets`) before it is uploaded; everything
 * else is left alone. The codec is a stand-in that models what the browser's
 * canvas does to size: bigger pictures and higher quality make bigger files.
 */
import { describe, expect, it } from 'vitest'
import { ATTACHMENT_IMAGE_MAX_DIM, ATTACHMENT_IMAGE_TARGET_BYTES } from '@ion/shared/attachment-image-targets'
import { prepareImageForUpload, type DecodedImage, type ImageCodec } from './attachment-image-prep'

interface FakeImage extends DecodedImage { closed: boolean }

function codec(opts: { width: number; height: number; hasAlpha?: boolean; decodes?: boolean; bytesPerPixel?: number }): ImageCodec<FakeImage> & { encodes: Array<{ w: number; h: number; type: string; q: number }> } {
  const encodes: Array<{ w: number; h: number; type: string; q: number }> = []
  return {
    encodes,
    async decode() {
      if (opts.decodes === false) throw new Error('cannot decode')
      const image: FakeImage = { width: opts.width, height: opts.height, hasAlpha: opts.hasAlpha ?? false, closed: false, close() { image.closed = true } }
      return image
    },
    async encode(_image, w, h, type, q) {
      encodes.push({ w, h, type, q })
      // JPEG shrinks with quality; PNG ignores it.
      const size = Math.round(w * h * (opts.bytesPerPixel ?? 0.5) * (type === 'image/jpeg' ? q : 2))
      return new Blob([new Uint8Array(size)], { type })
    },
  }
}

const photo = (bytes: number, type = 'image/jpeg', name = 'IMG_4501.jpg'): File => new File([new Uint8Array(bytes)], name, { type })

describe('prepareImageForUpload', () => {
  it('brings a large phone photo down to the long-edge and size targets, as a JPEG', async () => {
    const c = codec({ width: 4032, height: 3024 })
    const result = await prepareImageForUpload(photo(40_000_000), c)

    expect(result.resized).toBe(true)
    expect(result.file.type).toBe('image/jpeg')
    expect(result.file.name).toBe('IMG_4501.jpg')
    expect(result.file.size).toBeLessThanOrEqual(ATTACHMENT_IMAGE_TARGET_BYTES)
    const last = c.encodes.at(-1)!
    expect(Math.max(last.w, last.h)).toBe(ATTACHMENT_IMAGE_MAX_DIM)
    expect(last.w / last.h).toBeCloseTo(4032 / 3024, 2)
  })

  it('keeps the proportions of a portrait photo', async () => {
    const c = codec({ width: 3024, height: 4032 })
    await prepareImageForUpload(photo(30_000_000), c)
    const last = c.encodes.at(-1)!
    expect([last.w, last.h]).toEqual([1176, 1568])
  })

  it('passes a small image through untouched, and does not re-encode it', async () => {
    const c = codec({ width: 800, height: 600 })
    const file = photo(200_000)
    const result = await prepareImageForUpload(file, c)

    expect(result).toEqual({ file, resized: false, note: 'within-targets' })
    expect(c.encodes).toHaveLength(0)
  })

  it('shrinks a small-dimension image that is still too heavy', async () => {
    const c = codec({ width: 1400, height: 1000, bytesPerPixel: 2 })
    const result = await prepareImageForUpload(photo(5_000_000), c)
    expect(result.resized).toBe(true)
    expect(result.file.size).toBeLessThanOrEqual(ATTACHMENT_IMAGE_TARGET_BYTES)
  })

  it('keeps transparency by staying PNG when the shrunk PNG fits', async () => {
    const c = codec({ width: 2400, height: 1800, hasAlpha: true, bytesPerPixel: 0.05 })
    const result = await prepareImageForUpload(photo(9_000_000, 'image/png', 'logo.png'), c)

    expect(result.resized).toBe(true)
    expect(result.file.type).toBe('image/png')
    expect(result.file.name).toBe('logo.png')
  })

  it('flattens to JPEG when a transparent PNG cannot fit as PNG', async () => {
    const c = codec({ width: 4000, height: 3000, hasAlpha: true, bytesPerPixel: 2 })
    const result = await prepareImageForUpload(photo(30_000_000, 'image/png', 'scan.png'), c)

    expect(result.file.type).toBe('image/jpeg')
    expect(result.file.name).toBe('scan.jpg')
  })

  it('reads an image from its extension when the browser reports no type (HEIC from a phone)', async () => {
    const c = codec({ width: 4032, height: 3024 })
    const result = await prepareImageForUpload(photo(12_000_000, '', 'IMG_1.HEIC'), c)

    expect(result.resized).toBe(true)
    expect(result.file.type).toBe('image/jpeg')
    expect(result.file.name).toBe('IMG_1.jpg')
  })

  it('uploads the original when the browser cannot decode the image', async () => {
    const file = photo(30_000_000, 'image/heic', 'IMG_2.heic')
    const result = await prepareImageForUpload(file, codec({ width: 1, height: 1, decodes: false }))

    expect(result).toEqual({ file, resized: false, note: 'undecodable' })
  })

  it('leaves a PDF, a text file, a GIF, and an SVG exactly as they are', async () => {
    const c = codec({ width: 5000, height: 5000 })
    for (const [type, name] of [['application/pdf', 'a.pdf'], ['text/plain', 'a.txt'], ['image/gif', 'a.gif'], ['image/svg+xml', 'a.svg']] as const) {
      const file = photo(30_000_000, type, name)
      const result = await prepareImageForUpload(file, c)
      expect(result.file).toBe(file)
      expect(result.resized).toBe(false)
    }
    expect(c.encodes).toHaveLength(0)
  })

  it('releases the decoded image', async () => {
    let held: FakeImage | null = null
    const c = codec({ width: 4000, height: 3000 })
    const decode = c.decode.bind(c)
    c.decode = async (f) => { held = await decode(f); return held }
    await prepareImageForUpload(photo(20_000_000), c)
    expect(held!.closed).toBe(true)
  })
})
