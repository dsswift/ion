import { describe, it, expect } from 'vitest'
import {
  encrypt,
  decrypt,
  generateKey,
  generateKeyPair,
  deriveSharedSecret,
  deriveChannelId,
  createAuthNonce,
  createAuthProof,
  verifyAuthProof,
} from './index'

describe('e2e channel crypto', () => {
  it('round-trips a plaintext through encrypt/decrypt with the same key', () => {
    const key = generateKey()
    const { nonce, ciphertext } = encrypt('hello studio', key)
    const plain = decrypt(nonce, ciphertext, key)
    expect(plain?.toString('utf-8')).toBe('hello studio')
  })

  it('fails closed (returns null) on a tampered ciphertext', () => {
    const key = generateKey()
    const { nonce, ciphertext } = encrypt('hello studio', key)
    const tampered = Buffer.from(ciphertext, 'base64')
    tampered[0] ^= 0xff
    expect(decrypt(nonce, tampered.toString('base64'), key)).toBeNull()
  })

  it('fails closed on the wrong key', () => {
    const { nonce, ciphertext } = encrypt('hello studio', generateKey())
    expect(decrypt(nonce, ciphertext, generateKey())).toBeNull()
  })

  it('X25519 + HKDF produces the same shared secret on both sides', () => {
    const a = generateKeyPair()
    const b = generateKeyPair()
    const secretA = deriveSharedSecret(a.secretKey, b.publicKey)
    const secretB = deriveSharedSecret(b.secretKey, a.publicKey)
    expect(secretA.equals(secretB)).toBe(true)
    expect(deriveChannelId(secretA)).toBe(deriveChannelId(secretB))
  })

  it('HMAC auth proof verifies against the shared secret and rejects a wrong one', () => {
    const secret = generateKey()
    const nonce = createAuthNonce()
    const proof = createAuthProof(nonce, secret)
    expect(verifyAuthProof(nonce, proof, secret)).toBe(true)
    expect(verifyAuthProof(nonce, proof, generateKey())).toBe(false)
  })
})
