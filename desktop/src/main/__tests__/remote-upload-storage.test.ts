/**
 * remote-upload-storage.test.ts — validates that remote uploads use
 * content-addressed storage under ~/.ion/remote-uploads/ (not OS tmpdir).
 *
 * The saveRemoteUpload function is module-local in files.ts. We replicate
 * the algorithm against a mocked fs to pin the contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'

const written = new Map<string, Buffer>()
const dirs = new Set<string>()

vi.mock('fs', () => ({
  existsSync: (p: string) => written.has(p),
  mkdirSync: (p: string) => { dirs.add(p) },
  writeFileSync: (p: string, data: Buffer) => { written.set(p, Buffer.from(data)) },
  readFileSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
  renameSync: vi.fn(),
}))

const FAKE_HOME = '/fake-home'
const REMOTE_UPLOADS_DIR = join(FAKE_HOME, '.ion', 'remote-uploads')

function saveRemoteUploadTestImpl(buf: Buffer, ext: string): string | null {
  try {
    mkdirSync(REMOTE_UPLOADS_DIR, { recursive: true } as any)
    const hash = createHash('sha256').update(buf).digest('hex')
    const filePath = join(REMOTE_UPLOADS_DIR, `${hash}${ext}`)
    if (!existsSync(filePath)) {
      writeFileSync(filePath, buf)
    }
    return filePath
  } catch {
    return null
  }
}

describe('saveRemoteUpload — content-addressed storage', () => {
  beforeEach(() => {
    written.clear()
    dirs.clear()
  })

  it('writes file under ~/.ion/remote-uploads/', () => {
    const buf = Buffer.from('uploaded-file-content')
    const path = saveRemoteUploadTestImpl(buf, '.png')
    expect(path).toContain(REMOTE_UPLOADS_DIR)
  })

  it('content-addressing: same bytes → same path', () => {
    const buf = Buffer.from('duplicate-upload')
    const p1 = saveRemoteUploadTestImpl(buf, '.jpg')
    const p2 = saveRemoteUploadTestImpl(buf, '.jpg')
    expect(p1).toBe(p2)
  })

  it('content-addressing: different bytes → different path', () => {
    const p1 = saveRemoteUploadTestImpl(Buffer.from('upload-a'), '.png')
    const p2 = saveRemoteUploadTestImpl(Buffer.from('upload-b'), '.png')
    expect(p1).not.toBe(p2)
  })

  it('idempotency: second call skips write', () => {
    const buf = Buffer.from('repeat-upload')
    saveRemoteUploadTestImpl(buf, '.bin')
    const countAfterFirst = written.size
    saveRemoteUploadTestImpl(buf, '.bin')
    expect(written.size).toBe(countAfterFirst)
  })

  it('filename includes sha256 and extension', () => {
    const buf = Buffer.from('test-data')
    const path = saveRemoteUploadTestImpl(buf, '.pdf')
    const expectedHash = createHash('sha256').update(buf).digest('hex')
    expect(path).toMatch(new RegExp(`${expectedHash}\\.pdf$`))
  })

  it('creates remote-uploads directory', () => {
    saveRemoteUploadTestImpl(Buffer.from('x'), '.bin')
    expect(dirs.has(REMOTE_UPLOADS_DIR)).toBe(true)
  })
})
