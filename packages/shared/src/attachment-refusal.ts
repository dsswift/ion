/**
 * Why a file could not become an attachment, in words a person can act on.
 * The server says it when it refuses stored bytes; the client says it for the
 * checks it makes before uploading. One wording, so both sides read alike.
 */

export type AttachmentRefusalCode =
  | 'attachment_too_large'
  | 'attachment_malformed'
  | 'attachment_write_failed'
  | 'attachment_unreadable'

/**
 * Megabytes in the unit the limits are written in (1 MB = 1,048,576 bytes), so
 * a 25 MiB limit reads as 25 MB. Whole numbers from ten up, one decimal below.
 */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`
}

export interface AttachmentRefusalDetail {
  /** The file's name, so a message about several files says which one. */
  name?: string
  /** The size that was offered, for "too large". */
  bytes?: number
  /** The largest size accepted, for "too large". */
  limitBytes?: number
  /** An image the browser could not decode to shrink (a format it does not read). */
  undecodableImage?: boolean
}

export function attachmentRefusalMessage(code: AttachmentRefusalCode, detail: AttachmentRefusalDetail = {}): string {
  const subject = detail.name ? detail.name : 'This file'
  switch (code) {
    case 'attachment_too_large': {
      const sizes = detail.bytes !== undefined && detail.limitBytes !== undefined
        ? ` (${formatMegabytes(detail.bytes)}; the limit is ${formatMegabytes(detail.limitBytes)})`
        : ''
      return detail.undecodableImage
        ? `${subject} is an image this browser cannot shrink, and it is too large to attach${sizes}.`
        : `${subject} is too large to attach${sizes}.`
    }
    case 'attachment_malformed':
      return `${subject} could not be attached because its data was not in a form the server accepts.`
    case 'attachment_write_failed':
      return `The server could not store ${detail.name ?? 'this file'}. Try again.`
    case 'attachment_unreadable':
      return `${subject} could not be read from your device.`
  }
}
