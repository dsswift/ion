/**
 * Tests for the paired-device shared-secret decode guard.
 *
 * The guard exists because `Buffer.from(value, 'base64')` never throws: Node's
 * base64 decoder silently skips characters outside the alphabet. A corrupt
 * record therefore produced a wrong-length, wrong-valued key instead of a
 * detectable failure, and the resulting symptoms ("invalid proof",
 * "decryption failed") pointed at the client rather than at the stored record.
 */

import { describe, it, expect } from 'vitest'
import { randomBytes } from 'crypto'
import { decodeSharedSecret, looksEncrypted, describeSecretFailure } from '../device-secret'

describe('decodeSharedSecret', () => {
  it('accepts a well-formed 32-byte base64 secret', () => {
    const raw = randomBytes(32)
    const result = decodeSharedSecret(raw.toString('base64'))

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.secret).toHaveLength(32)
      expect(result.secret.equals(raw)).toBe(true)
    }
  })

  // The exact production failure: safeStorage could not decrypt the value, so
  // the secret store handed back the prefixed ciphertext. Base64-decoding that
  // string succeeds and yields a plausible-looking Buffer, which is why this
  // has to be rejected on the prefix rather than on decode failure.
  it('rejects a value still carrying an enc:v1: at-rest prefix', () => {
    const ciphertext = 'enc:v1:' + randomBytes(48).toString('base64')

    const result = decodeSharedSecret(ciphertext)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('encrypted')
  })

  it('rejects enc:v2: and enc:v3: prefixed values too', () => {
    for (const prefix of ['enc:v2:', 'enc:v3:']) {
      const result = decodeSharedSecret(prefix + randomBytes(48).toString('base64'))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('encrypted')
    }
  })

  // Pins the primitive that made the bug invisible. If this ever throws
  // instead, the guard's reason for existing has changed.
  it('rejects a prefixed value that base64-decodes without throwing', () => {
    const ciphertext = 'enc:v1:' + randomBytes(48).toString('base64')

    // Demonstrate the unsafe path the guard replaces.
    expect(() => Buffer.from(ciphertext, 'base64')).not.toThrow()
    expect(Buffer.from(ciphertext, 'base64').length).toBeGreaterThan(0)

    expect(decodeSharedSecret(ciphertext).ok).toBe(false)
  })

  it('rejects a secret that decodes to the wrong length', () => {
    const result = decodeSharedSecret(randomBytes(16).toString('base64'))

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('wrong-length')
      expect(result.byteLength).toBe(16)
    }
  })

  it('rejects missing / empty secrets', () => {
    for (const value of ['', undefined, null]) {
      const result = decodeSharedSecret(value)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe('missing')
    }
  })
})

describe('looksEncrypted', () => {
  it('detects every at-rest prefix and nothing else', () => {
    expect(looksEncrypted('enc:v1:abc')).toBe(true)
    expect(looksEncrypted('enc:v2:abc')).toBe(true)
    expect(looksEncrypted('enc:v3:abc')).toBe(true)
    expect(looksEncrypted(randomBytes(32).toString('base64'))).toBe(false)
  })
})

describe('describeSecretFailure', () => {
  it('gives a distinct explanation for each failure reason', () => {
    const reasons = ['missing', 'encrypted', 'wrong-length'] as const
    const described = reasons.map(describeSecretFailure)

    expect(new Set(described).size).toBe(reasons.length)
    for (const text of described) expect(text.length).toBeGreaterThan(0)
  })
})
