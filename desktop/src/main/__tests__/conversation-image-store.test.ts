/**
 * conversation-image-store.test.ts
 *
 * Pinning tests for the TypeScript content-addressed image saver used by the
 * desktop-side conversation loaders (disk fallback + engine-conversation
 * direct read) when the engine RPC is unavailable. Mirrors the engine's
 * image_store.go behavior: content-addressed filenames (sha256 of the decoded
 * bytes), idempotent writes, media-type→extension mapping, and on-disk paths
 * (never base64) on the returned attachment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { saveImageToConversation, imageAttachmentFromBlock } from '../conversation-image-store'

// A tiny valid PNG (1x1). Bytes are arbitrary for the store — it hashes them.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03])
const PNG_B64 = PNG_BYTES.toString('base64')

let testDir: string

beforeEach(() => {
  testDir = join(tmpdir(), `img-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(testDir, { recursive: true })
})

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
})

describe('saveImageToConversation', () => {
  it('writes a content-addressed file (sha256 of bytes) and returns its path', () => {
    const path = saveImageToConversation('conv-1', 'image/png', PNG_B64, testDir)
    expect(path).not.toBeNull()
    const sum = createHash('sha256').update(PNG_BYTES).digest('hex')
    expect(path).toBe(join(testDir, 'conv-1', 'images', `${sum}.png`))
    expect(existsSync(path!)).toBe(true)
    expect(readFileSync(path!)).toEqual(PNG_BYTES)
  })

  it('is idempotent: the same bytes resolve to the same file and skip re-write', () => {
    const p1 = saveImageToConversation('conv-1', 'image/png', PNG_B64, testDir)
    // Corrupt the file, then save again — content-addressing means the path is
    // the same and the existing (corrupt) file is NOT overwritten (skip-on-present).
    writeFileSync(p1!, Buffer.from('tampered'))
    const p2 = saveImageToConversation('conv-1', 'image/png', PNG_B64, testDir)
    expect(p2).toBe(p1)
    expect(readFileSync(p2!).toString()).toBe('tampered')
  })

  it('maps media types to extensions and falls back to .bin for unknown types', () => {
    expect(saveImageToConversation('c', 'image/jpeg', PNG_B64, testDir)).toMatch(/\.jpg$/)
    expect(saveImageToConversation('c', 'image/webp', PNG_B64, testDir)).toMatch(/\.webp$/)
    expect(saveImageToConversation('c', 'application/x-weird', PNG_B64, testDir)).toMatch(/\.bin$/)
  })

  it('returns null on empty inputs', () => {
    expect(saveImageToConversation('', 'image/png', PNG_B64, testDir)).toBeNull()
    expect(saveImageToConversation('c', 'image/png', '', testDir)).toBeNull()
  })
})

describe('imageAttachmentFromBlock', () => {
  it('builds an attachment carrying the on-disk path (never base64)', () => {
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }
    const att = imageAttachmentFromBlock('conv-1', block, testDir)
    expect(att).not.toBeNull()
    expect(att!.type).toBe('image')
    expect(att!.mimeType).toBe('image/png')
    expect(att!.path).toContain(join('conv-1', 'images'))
    expect(att!.path).not.toContain(PNG_B64)
    expect(att!.id).toBe('img:' + att!.path)
    expect(att!.name).toBe(att!.path.split('/').pop())
  })

  it('returns null when the block has no image source', () => {
    expect(imageAttachmentFromBlock('conv-1', { type: 'image' }, testDir)).toBeNull()
    expect(imageAttachmentFromBlock('conv-1', { type: 'text', text: 'hi' }, testDir)).toBeNull()
  })
})
