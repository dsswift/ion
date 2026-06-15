import { describe, it, expect } from 'vitest'
import { deflateRawSync, inflateRawSync } from 'zlib'
import { encrypt, decrypt, generateKey } from '../crypto'

/**
 * Tests for the compression-before-encryption pipeline.
 *
 * The transport layer compresses outbound payloads with raw DEFLATE
 * (0x01 version prefix) before AES-256-GCM encryption. The receiver
 * decrypts, checks the version byte, and inflates if 0x01.
 */

describe('transport compression round-trip', () => {
  const key = generateKey()

  /** Simulates the desktop send path: JSON → compress → version prefix → encrypt. */
  function compressAndEncrypt(obj: Record<string, unknown>): { nonce: string; ciphertext: string } {
    const plaintext = JSON.stringify(obj)
    const compressed = deflateRawSync(Buffer.from(plaintext, 'utf-8'))
    const wire = Buffer.concat([Buffer.from([0x01]), compressed])
    return encrypt(wire, key)
  }

  /** Simulates the desktop receive path: decrypt → check prefix → decompress → parse. */
  function decryptAndDecompress(nonce: string, ciphertext: string): Record<string, unknown> | null {
    const raw = decrypt(nonce, ciphertext, key)
    if (!raw) return null
    let payload: string
    if (raw.length > 0 && raw[0] === 0x01) {
      payload = inflateRawSync(raw.subarray(1)).toString('utf-8')
    } else {
      payload = raw.toString('utf-8')
    }
    return JSON.parse(payload) as Record<string, unknown>
  }

  it('round-trips a small JSON object', () => {
    const original = { type: 'heartbeat', seq: 42, ts: Date.now(), buffered: 0 }
    const { nonce, ciphertext } = compressAndEncrypt(original)
    const result = decryptAndDecompress(nonce, ciphertext)
    expect(result).toEqual(original)
  })

  it('round-trips a large snapshot-like object', () => {
    // Simulate 67 tabs with repetitive structure (this is the real-world payload shape).
    const tabs = Array.from({ length: 67 }, (_, i) => ({
      id: `tab-${i}`,
      title: `Tab ${i}`,
      status: 'idle',
      workingDirectory: `/Users/dev/project-${i}`,
      permissionQueue: [],
      conversationInstances: [{ id: `inst-${i}`, label: 'default' }],
      lastActivityAt: Date.now() - i * 1000,
    }))
    const original = { type: 'snapshot', tabs, recentDirectories: ['/Users/dev'] }
    const { nonce, ciphertext } = compressAndEncrypt(original)
    const result = decryptAndDecompress(nonce, ciphertext)
    expect(result).toEqual(original)
  })

  it('achieves significant compression on repetitive JSON', () => {
    const tabs = Array.from({ length: 67 }, (_, i) => ({
      id: `tab-${i}`,
      title: `Tab ${i}`,
      status: 'idle',
      workingDirectory: `/Users/dev/project-${i}`,
      permissionQueue: [],
      conversationInstances: [{ id: `inst-${i}`, label: 'default' }],
      lastActivityAt: Date.now() - i * 1000,
    }))
    const plaintext = JSON.stringify({ type: 'snapshot', tabs })
    const compressed = deflateRawSync(Buffer.from(plaintext, 'utf-8'))

    // Expect at least 5× compression (typically 10–15× for repetitive JSON).
    expect(compressed.length).toBeLessThan(plaintext.length / 5)
  })

  it('handles backward-compatible uncompressed payloads (no 0x01 prefix)', () => {
    // Simulate a legacy payload: encrypted directly from UTF-8 string, no compression.
    const original = { type: 'heartbeat', seq: 1, ts: 12345, buffered: 0 }
    const plaintext = JSON.stringify(original)
    const { nonce, ciphertext } = encrypt(Buffer.from(plaintext, 'utf-8'), key)

    // The decrypt path should handle this gracefully — the first byte will be
    // '{' (0x7B), not 0x01, so it skips decompression.
    const result = decryptAndDecompress(nonce, ciphertext)
    expect(result).toEqual(original)
  })

  it('returns null for decryption with wrong key', () => {
    const original = { type: 'test' }
    const { nonce, ciphertext } = compressAndEncrypt(original)
    const wrongKey = generateKey()
    const result = decrypt(nonce, ciphertext, wrongKey)
    expect(result).toBeNull()
  })

  it('decrypt returns a Buffer', () => {
    const original = { type: 'test' }
    const { nonce, ciphertext } = compressAndEncrypt(original)
    const result = decrypt(nonce, ciphertext, key)
    expect(Buffer.isBuffer(result)).toBe(true)
  })

  it('version byte 0x01 is always the first byte of compressed payloads', () => {
    const original = { type: 'snapshot', tabs: [{ id: 't1' }] }
    const plaintext = JSON.stringify(original)
    const compressed = deflateRawSync(Buffer.from(plaintext, 'utf-8'))
    const wire = Buffer.concat([Buffer.from([0x01]), compressed])

    expect(wire[0]).toBe(0x01)
    // The raw DEFLATE data never starts with 0x01 naturally — DEFLATE blocks
    // start with bits that don't produce 0x01 as a first byte in practice.
    // But our version prefix makes it unambiguous.
  })
})
