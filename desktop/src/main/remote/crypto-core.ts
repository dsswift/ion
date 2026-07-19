/**
 * Pure AES-256-GCM primitives shared by the main thread and the transport
 * crypto worker (transport-crypto-worker.ts).
 *
 * This module must stay PURE: Node `crypto` only — no logger, no electron, no
 * watchdog imports. It is loaded inside a worker_threads context where the
 * main-process logger is unsafe (two threads appending/rotating the same
 * desktop.jsonl would race). The logging-aware wrappers live in crypto.ts,
 * which re-exports these primitives for all existing main-thread callers.
 *
 * Wire format matches iOS CryptoKit AES.GCM (12-byte nonce, 16-byte tag
 * appended to the ciphertext). See crypto.ts for the full protocol notes.
 */

import { randomBytes, createCipheriv } from 'crypto'

export const KEY_LENGTH = 32
export const NONCE_LENGTH = 12 // AES-256-GCM uses 12-byte nonce (recommended)
export const TAG_LENGTH = 16   // GCM auth tag
export const CIPHER_ALG = 'aes-256-gcm' as const

/** Generate a random 12-byte nonce for AES-256-GCM. */
export function generateNonce(): Buffer {
  return randomBytes(NONCE_LENGTH)
}

/**
 * Encrypt a plaintext payload with AES-256-GCM.
 *
 * Accepts a UTF-8 string or a raw Buffer (for pre-compressed payloads).
 * Returns { nonce, ciphertext } both as base64 strings.
 * The ciphertext includes the 16-byte GCM auth tag appended.
 * This matches iOS CryptoKit AES.GCM.seal() output format.
 */
export function encrypt(plaintext: string | Buffer, key: Buffer): { nonce: string; ciphertext: string } {
  const nonce = generateNonce()
  const plaintextBuf = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf-8')

  const cipher = createCipheriv(CIPHER_ALG, key, nonce, { authTagLength: TAG_LENGTH })
  const encrypted = Buffer.concat([cipher.update(plaintextBuf), cipher.final()])
  const tag = cipher.getAuthTag()

  // iOS AES.GCM.SealedBox stores: ciphertext + tag
  const combined = Buffer.concat([encrypted, tag])

  return {
    nonce: nonce.toString('base64'),
    ciphertext: combined.toString('base64'),
  }
}
