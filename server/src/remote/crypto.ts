/**
 * E2E encryption for remote control messages.
 *
 * Uses AES-256-GCM (12-byte nonce, 16-byte tag) via Node.js crypto for
 * authenticated encryption. Wire-compatible with iOS CryptoKit AES.GCM.
 *
 * Note: ChaCha20-Poly1305 is not available in Electron's BoringSSL.
 * AES-256-GCM has equivalent security properties and is universally
 * supported across Node.js, Electron, and iOS CryptoKit.
 *
 * Key exchange: X25519 Diffie-Hellman during pairing, shared secret
 * derived via HKDF-SHA256.
 */

import { NONCE_LENGTH, TAG_LENGTH } from '@ion/shared/e2e'
import {
  generateNonce,
  encrypt,
  generateKey,
  generateDeviceToken,
  deriveChannelId,
  decrypt as decryptPure,
  generateKeyPair,
  deriveSharedSecret,
  createAuthNonce,
  createAuthProof,
  verifyAuthProof,
} from '@ion/shared/e2e'
import { log as _log } from '../logger'

// The pure primitives live in packages/shared/src/e2e/ (spec 12) so the
// server and the desktop's transport-relay.ts share one implementation.
// Re-exported here so all existing callers keep their import site; only
// `decrypt` gets a logging wrapper below.
export {
  generateNonce,
  encrypt,
  generateKey,
  generateDeviceToken,
  deriveChannelId,
  generateKeyPair,
  deriveSharedSecret,
  createAuthNonce,
  createAuthProof,
  verifyAuthProof,
}

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('Crypto', msg, fields)
}

/**
 * Decrypt an AES-256-GCM ciphertext.
 *
 * Expects ciphertext with the 16-byte auth tag appended (same format
 * as iOS CryptoKit AES.GCM.SealedBox).
 *
 * Returns the raw decrypted Buffer, or null if decryption fails
 * (tampered, wrong key, or wrong nonce). Callers inspect the first
 * byte to determine whether the payload is compressed (0x01 prefix)
 * or raw UTF-8 text, then call `.toString('utf-8')` as appropriate.
 *
 * Thin logging wrapper over the pure `@ion/shared/e2e` decrypt, which
 * carries no logger of its own.
 */
export function decrypt(nonceB64: string, ciphertextB64: string, key: Buffer): Buffer | null {
  const nonce = Buffer.from(nonceB64, 'base64')
  const combined = Buffer.from(ciphertextB64, 'base64')
  if (nonce.length !== NONCE_LENGTH) {
    log('crypto: invalid nonce length', { nonce_len: nonce.length, expected: NONCE_LENGTH })
    return null
  }
  if (combined.length < TAG_LENGTH) {
    log('crypto: ciphertext too short', { bytes: combined.length })
    return null
  }
  const result = decryptPure(nonceB64, ciphertextB64, key)
  if (result === null) {
    log('Decryption failed (wrong key, tampered, or wrong nonce)')
  }
  return result
}
