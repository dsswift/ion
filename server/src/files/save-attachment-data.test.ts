import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attachmentDataDir, saveAttachmentData as save, type SavedAttachment } from './save-attachment-data'

/** The stored row for a request that is expected to be accepted. */
function saveAttachmentData(request: unknown): SavedAttachment {
  const result = save(request)
  if ('refused' in result) throw new Error(`expected the attachment to be stored, got: ${result.message}`)
  return result
}

describe('saveAttachmentData', () => {
  let dir: string
  const previous = process.env.ION_DATA_DIR
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ion-attach-')); process.env.ION_DATA_DIR = dir })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.ION_DATA_DIR
    else process.env.ION_DATA_DIR = previous
  })

  it('stores the bytes under the data directory and returns a row carrying the display name', () => {
    const row = saveAttachmentData({ name: 'pasted-text-1.txt', base64: Buffer.from('hello').toString('base64') })
    expect(row).toMatchObject({ name: 'pasted-text-1.txt', type: 'file', mimeType: 'text/plain', size: 5 })
    expect(row.path.startsWith(attachmentDataDir())).toBe(true)
    expect(readFileSync(row.path, 'utf8')).toBe('hello')
  })

  it('stores identical content once', () => {
    const base64 = Buffer.from('same').toString('base64')
    saveAttachmentData({ name: 'a.txt', base64 })
    saveAttachmentData({ name: 'b.txt', base64 })
    expect(readdirSync(attachmentDataDir())).toHaveLength(1)
  })

  it('never lets the client name choose the path', () => {
    const row = saveAttachmentData({ name: '../../escape.sh', base64: Buffer.from('x').toString('base64') })
    expect(row.path.startsWith(attachmentDataDir())).toBe(true)
    expect(row.path).not.toContain('escape')
  })

  it('refuses malformed input', () => {
    expect(save({ name: '', base64: 'aGk=' })).toMatchObject({ refused: 'attachment_malformed' })
    expect(save({ name: 'a.txt', base64: 'not base64!' })).toMatchObject({ refused: 'attachment_malformed' })
    expect(save(null)).toMatchObject({ refused: 'attachment_malformed' })
  })

  it('accepts a data URL, names the file from its media type, and returns the content hash', () => {
    const bytes = Buffer.from('not really a jpeg')
    const row = saveAttachmentData({ name: 'photo', dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}` })
    expect(row.contentHash).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(row.path).toBe(join(attachmentDataDir(), `${row.contentHash}.jpg`))
    expect(row.id).toBeTruthy()
    expect(readFileSync(row.path)).toEqual(bytes)
  })

  it('returns the content hash for a file that is not an image', () => {
    const row = saveAttachmentData({ name: 'notes.txt', base64: Buffer.from('hello').toString('base64') })
    expect(row.contentHash).toBe(createHash('sha256').update('hello').digest('hex'))
  })

  it('refuses a data URL that is not base64', () => {
    expect(save({ name: 'a.txt', dataUrl: 'data:text/plain,hello' })).toMatchObject({ refused: 'attachment_malformed' })
    expect(save({ name: 'a.txt', dataUrl: 'https://example.org/a.txt' })).toMatchObject({ refused: 'attachment_malformed' })
  })

  it('refuses an oversize file and says how large it was and what the limit is', () => {
    const bytes = Buffer.alloc(40 * 1024 * 1024, 1)
    const refusal = save({ name: 'photo.jpg', base64: bytes.toString('base64') })
    expect(refusal).toMatchObject({ refused: 'attachment_too_large' })
    expect((refusal as { message: string }).message).toBe('photo.jpg is too large to attach (40 MB; the limit is 25 MB).')
    expect(readdirSync(dir)).not.toContain('user-attachments')
  })

  it('says why when the stored file cannot be written', () => {
    writeFileSync(join(dir, 'user-attachments'), 'a file where the directory should be')
    const refusal = save({ name: 'a.txt', base64: Buffer.from('hi').toString('base64') })
    expect(refusal).toMatchObject({ refused: 'attachment_write_failed' })
  })
})
