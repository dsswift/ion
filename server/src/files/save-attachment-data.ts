/**
 * Store bytes a client holds as an attachment file the Environment can read.
 *
 * A client sometimes has content with no path on the Environment's machine: a
 * file dropped into a browser tab, or a paste too large to keep inline in the
 * prompt. An attachment is a path the engine reads at send time, so the bytes
 * have to land on the server's filesystem first. This writes them once,
 * content-addressed, and returns the same row `describeFile` gives a file that
 * was already there.
 *
 * Content-addressed storage means a repeated paste of the same text reuses one
 * file, and the stored name never trusts the client's name for a path segment.
 */
import { createHash } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { extname, join } from 'path'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { dataDir } from '../paths'
import { log as _log, warn as _warn } from '../logger'
import { describeFile, type DescribedFile } from './describe-file'
import { MAX_FILE_DATA_BYTES } from '@ion/shared/file-link'
import { attachmentRefusalMessage, type AttachmentRefusalCode } from '@ion/shared/attachment-refusal'

const TAG = 'save-attachment-data'

const MAX_NAME_LENGTH = 200

export interface SaveAttachmentDataRequest {
  /** Display name, e.g. `pasted-text-1.txt` or the dropped file's name. */
  name: string
  /** Standard base64 of the content. Either this or `dataUrl`. */
  base64?: string
  /** A `data:<mime>;base64,<content>` URL, for a client that holds its bytes that way. */
  dataUrl?: string
}

/** A stored attachment: the described file, always with the identity of its content. */
export type SavedAttachment = DescribedFile & { contentHash: string }

/** The request was refused, and why, in words the person who attached the file can read. */
export interface AttachmentRefusal {
  refused: AttachmentRefusalCode
  message: string
}

function refuse(code: AttachmentRefusalCode, name: unknown, detail: Omit<Parameters<typeof attachmentRefusalMessage>[1], 'name'> = {}): AttachmentRefusal {
  const shown = typeof name === 'string' && name.length > 0 && name.length <= MAX_NAME_LENGTH ? name : undefined
  return { refused: code, message: attachmentRefusalMessage(code, { ...detail, ...(shown ? { name: shown } : {}) }) }
}

export function attachmentDataDir(): string {
  return join(dataDir(), 'user-attachments')
}

/** Only a short, plain extension survives into the stored file name. */
function safeExtension(name: string): string {
  const ext = extname(name).toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''
}

/** The extension a data URL's media type implies, for a name that carries none (`image/jpeg` -> `.jpg`). */
function extensionForMime(mime: string): string {
  const sub = mime === 'image/jpeg' ? 'jpg' : (mime.split('/')[1] ?? '')
  return /^[a-z0-9]{1,10}$/i.test(sub) ? `.${sub.toLowerCase()}` : ''
}

/** Returns the refusal (after logging why) when the request is malformed, too large, or the write fails. */
export function saveAttachmentData(request: unknown): SavedAttachment | AttachmentRefusal {
  const name = (request as SaveAttachmentDataRequest | null)?.name
  const dataUrl = (request as SaveAttachmentDataRequest | null)?.dataUrl
  let base64: unknown = (request as SaveAttachmentDataRequest | null)?.base64
  let mimeExt = ''
  if (typeof dataUrl === 'string') {
    const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/s)
    if (!match) {
      _warn(TAG, 'rejected attachment data: not a base64 data URL', { name_length: typeof name === 'string' ? name.length : -1 })
      return refuse('attachment_malformed', name)
    }
    mimeExt = extensionForMime(match[1])
    base64 = match[2]
  }
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH
    || typeof base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    _warn(TAG, 'rejected malformed attachment data', { name_length: typeof name === 'string' ? name.length : -1 })
    return refuse('attachment_malformed', name)
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length > MAX_FILE_DATA_BYTES) {
    _warn(TAG, 'rejected oversize attachment data', { bytes: bytes.length, limit: MAX_FILE_DATA_BYTES })
    return refuse('attachment_too_large', name, { bytes: bytes.length, limitBytes: MAX_FILE_DATA_BYTES })
  }
  try {
    const dir = attachmentDataDir()
    mkdirSync(dir, { recursive: true })
    const hash = createHash('sha256').update(bytes).digest('hex')
    const filePath = join(dir, `${hash}${safeExtension(name) || mimeExt}`)
    const reused = existsSync(filePath)
    if (!reused) atomicWriteFileSync(filePath, bytes)
    _log(TAG, 'attachment data stored', { path: filePath, bytes: bytes.length, reused, from_data_url: typeof dataUrl === 'string' })
    const described = describeFile(filePath)
    // The stored name is a hash; the row shows the name the operator knows.
    // The hash is returned for every file, not only an image, so a client can
    // key its own cache on the content it just sent.
    if (!described) {
      _warn(TAG, 'stored attachment could not be described', { path: filePath })
      return refuse('attachment_write_failed', name)
    }
    return { ...described, name, contentHash: hash }
  } catch (err) {
    _warn(TAG, 'attachment data write failed', { error: String(err) })
    return refuse('attachment_write_failed', name)
  }
}
