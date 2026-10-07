/**
 * Shrinks a photo in the browser before it is uploaded.
 *
 * A phone camera's original is several times what the model can use: the
 * server resizes every image to `ATTACHMENT_IMAGE_MAX_DIM` on the long edge
 * and `ATTACHMENT_IMAGE_TARGET_BYTES` before the model sees it. Uploading the
 * original only spends the person's connection and runs into the upload cap.
 * This aims at the same targets, shared from one file with the server.
 *
 * What is touched: a raster image the browser can decode (JPEG, PNG, WebP,
 * and whatever else the platform reads, HEIC on Safari). What is not: a PDF
 * or any non-image file, an animated GIF, an SVG, and an image already within
 * both targets. An image the browser cannot decode is uploaded as it is, and
 * the upload's size check speaks if it is too large.
 *
 * The codecs are passed in so the rules are tested without a browser canvas;
 * `browserImageCodec` is the real one.
 */
import { ATTACHMENT_IMAGE_MAX_DIM, ATTACHMENT_IMAGE_TARGET_BYTES } from '@ion/shared/attachment-image-targets'

/** A decoded image, already turned upright by its orientation metadata. */
export interface DecodedImage {
  width: number
  height: number
  /** True when any pixel is not fully opaque. */
  hasAlpha: boolean
  /** Releases the decoded pixels. */
  close(): void
}

export interface ImageCodec<T extends DecodedImage = DecodedImage> {
  /** Decodes `file`, applying its EXIF orientation. Rejects when the platform cannot read it. */
  decode(file: Blob): Promise<T>
  /** Draws `image` at `width` x `height` and encodes it. `quality` is 0..1 and ignored for PNG. */
  encode(image: T, width: number, height: number, type: 'image/jpeg' | 'image/png', quality: number): Promise<Blob>
}

export interface PreparedImage {
  /** What to upload. The original `file` itself when nothing needed doing. */
  file: File
  /** True when `file` is a re-encoded copy. */
  resized: boolean
  /** The reason the original went up unchanged, for the log. */
  note?: 'not-an-image' | 'kept-format' | 'within-targets' | 'undecodable'
}

/** Types the browser may be able to shrink. GIF, SVG, and anything else stay as they are. */
const SHRINKABLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])

const QUALITIES = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35]

function jpegName(name: string): string {
  const dot = name.lastIndexOf('.')
  return `${dot > 0 ? name.slice(0, dot) : name}.jpg`
}

/** The type a file claims, falling back to its extension for a browser that reports none (HEIC often has none). */
function imageTypeOf(file: File): string {
  if (file.type) return file.type.toLowerCase()
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif' } as Record<string, string>)[ext] ?? ''
}

export async function prepareImageForUpload<T extends DecodedImage>(file: File, codec: ImageCodec<T>): Promise<PreparedImage> {
  const type = imageTypeOf(file)
  if (!type.startsWith('image/')) return { file, resized: false, note: 'not-an-image' }
  if (!SHRINKABLE.has(type)) return { file, resized: false, note: 'kept-format' }

  let image: T
  try {
    image = await codec.decode(file)
  } catch {
    // HEIC on a browser that does not read it, or a file that is not the image it says it is.
    return { file, resized: false, note: 'undecodable' }
  }
  try {
    const longEdge = Math.max(image.width, image.height)
    if (longEdge <= ATTACHMENT_IMAGE_MAX_DIM && file.size <= ATTACHMENT_IMAGE_TARGET_BYTES && (type === 'image/jpeg' || type === 'image/png' || type === 'image/webp')) {
      return { file, resized: false, note: 'within-targets' }
    }
    const scale = longEdge > ATTACHMENT_IMAGE_MAX_DIM ? ATTACHMENT_IMAGE_MAX_DIM / longEdge : 1
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))

    // Transparency survives only in PNG, so an image that has some stays PNG
    // when it fits; one that does not fit as PNG is flattened like the server does.
    if (image.hasAlpha) {
      const png = await codec.encode(image, width, height, 'image/png', 1)
      if (png.size <= ATTACHMENT_IMAGE_TARGET_BYTES) return { file: new File([png], file.name.replace(/\.[^.]+$/, '') + '.png', { type: 'image/png' }), resized: true }
    }
    let smallest: Blob | null = null
    for (const quality of QUALITIES) {
      const jpeg = await codec.encode(image, width, height, 'image/jpeg', quality)
      smallest = jpeg
      if (jpeg.size <= ATTACHMENT_IMAGE_TARGET_BYTES) break
    }
    // The lowest quality tried, even over the target: the server's encoder does the same.
    return { file: new File([smallest!], jpegName(file.name), { type: 'image/jpeg' }), resized: true }
  } finally {
    image.close()
  }
}

interface BrowserImage extends DecodedImage {
  bitmap: ImageBitmap
}

/** A drawing surface: an OffscreenCanvas where the browser has one, a canvas element where it does not. */
function surface(width: number, height: number): { ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null; toBlob(type: string, quality: number): Promise<Blob> } {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height)
    return { ctx: canvas.getContext('2d'), toBlob: (type, quality) => canvas.convertToBlob({ type, quality }) }
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return {
    ctx: canvas.getContext('2d'),
    toBlob: (type, quality) => new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas could not encode the image'))), type, quality)),
  }
}

/** The browser's own codec: `createImageBitmap` to decode (upright), a canvas to scale and encode. */
export const browserImageCodec: ImageCodec<BrowserImage> = {
  async decode(file) {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const probe = surface(Math.max(1, Math.min(bitmap.width, 64)), Math.max(1, Math.min(bitmap.height, 64)))
    let hasAlpha = false
    if (probe.ctx) {
      probe.ctx.drawImage(bitmap, 0, 0, Math.min(bitmap.width, 64), Math.min(bitmap.height, 64))
      const { data } = probe.ctx.getImageData(0, 0, Math.min(bitmap.width, 64), Math.min(bitmap.height, 64))
      for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { hasAlpha = true; break }
    }
    return { width: bitmap.width, height: bitmap.height, hasAlpha, close: () => bitmap.close(), bitmap }
  },
  async encode(image, width, height, type, quality) {
    const target = surface(width, height)
    if (!target.ctx) throw new Error('no 2d canvas context')
    // JPEG has no alpha: paint white first so a transparent area is not black.
    if (type === 'image/jpeg') target.ctx.fillStyle = '#ffffff' // hardcoded-ok: pixels of the uploaded image, not interface color
    if (type === 'image/jpeg') target.ctx.fillRect(0, 0, width, height)
    target.ctx.imageSmoothingQuality = 'high'
    target.ctx.drawImage(image.bitmap, 0, 0, width, height)
    return target.toBlob(type, quality)
  },
}
