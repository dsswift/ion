/**
 * Pure E2E channel crypto shared by the server and the desktop (manifest
 * requirement: one implementation, both sides import it — see spec 12
 * "Technical Approach and Evidence").
 *
 * Moved from `server/src/remote/crypto-core.ts` (AES-256-GCM primitives) and
 * the pure key-exchange/HMAC helpers previously duplicated only inside
 * `server/src/remote/crypto.ts`. This module stays PURE: Node `crypto` only —
 * no logger, no electron, no watchdog imports — so it loads inside the
 * headless server process and inside the desktop's Electron main process
 * without pulling in either side's logging-aware wrappers.
 *
 * Wire format matches iOS CryptoKit AES.GCM (12-byte nonce, 16-byte tag
 * appended to the ciphertext).
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  generateKeyPairSync,
  diffieHellman,
  createPublicKey,
  createPrivateKey,
  timingSafeEqual,
} from 'crypto'

export const KEY_LENGTH = 32
export const NONCE_LENGTH = 12 // AES-256-GCM uses a 12-byte nonce (recommended)
export const TAG_LENGTH = 16 // GCM auth tag
export const CIPHER_ALG = 'aes-256-gcm' as const
/** The HKDF info string of the pairing key derivation; both ends of a pairing must share it. */
export const E2E_KEY_DERIVATION_VERSION = 'ion-remote-v1'

/** Generate a random 12-byte nonce for AES-256-GCM. */
export function generateNonce(): Buffer {
  return randomBytes(NONCE_LENGTH)
}

/** Generate a random 256-bit key. */
export function generateKey(): Buffer {
  return randomBytes(KEY_LENGTH)
}

/** Generate a 256-bit device token. */
export function generateDeviceToken(): Buffer {
  return randomBytes(32)
}

/**
 * Encrypt a plaintext payload with AES-256-GCM.
 *
 * Accepts a UTF-8 string or a raw Buffer (for pre-compressed payloads).
 * Returns { nonce, ciphertext } both as base64 strings. The ciphertext
 * includes the 16-byte GCM auth tag appended, matching iOS CryptoKit
 * AES.GCM.seal() output format.
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

/**
 * Decrypt an AES-256-GCM ciphertext produced by `encrypt`.
 *
 * Returns the raw decrypted Buffer, or null if decryption fails (tampered,
 * wrong key, wrong nonce, or malformed input). This is the pure variant —
 * callers that want a diagnostic log on failure (server's `crypto.ts`) wrap
 * this and log on a null result; this module never logs.
 */
export function decrypt(nonceB64: string, ciphertextB64: string, key: Buffer): Buffer | null {
  const nonce = Buffer.from(nonceB64, 'base64')
  const combined = Buffer.from(ciphertextB64, 'base64')

  if (nonce.length !== NONCE_LENGTH) return null
  if (combined.length < TAG_LENGTH) return null

  const ciphertext = combined.subarray(0, combined.length - TAG_LENGTH)
  const tag = combined.subarray(combined.length - TAG_LENGTH)

  try {
    const decipher = createDecipheriv(CIPHER_ALG, key, nonce, { authTagLength: TAG_LENGTH })
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    return null
  }
}

/**
 * Derive a channel ID from the shared secret: first 16 bytes of
 * SHA-256(key), hex-encoded (32 hex chars). Matches iOS
 * E2ECrypto.deriveChannelId().
 */
export function deriveChannelId(sharedSecret: Buffer): string {
  const hash = createHash('sha256').update(sharedSecret).digest()
  return hash.subarray(0, 16).toString('hex')
}

/**
 * X25519 key pair generation for Diffie-Hellman key exchange during pairing.
 * Returns { publicKey, secretKey } as raw 32-byte Buffers.
 */
export function generateKeyPair(): { publicKey: Buffer; secretKey: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(12)),
    secretKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16)),
  }
}

/** Simple HKDF-SHA256 extract + expand (RFC 5869). */
function hkdfSha256(ikm: Buffer, info: Buffer, length: number): Buffer {
  // Extract: PRK = HMAC-SHA256(salt=zeros, IKM)
  const prk = createHmac('sha256', Buffer.alloc(32, 0)).update(ikm).digest()
  // Expand: T(1) = HMAC-SHA256(PRK, info || 0x01) -- single round since length <= 32
  const t = createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest()
  return t.subarray(0, length)
}

/**
 * Derive a shared secret from our secret key and the peer's public key, via
 * X25519 Diffie-Hellman then HKDF-SHA256 with info "ion-remote-v1"
 * (matches iOS CryptoKit HKDF derivation).
 */
export function deriveSharedSecret(ourSecretKey: Buffer, theirPublicKey: Buffer): Buffer {
  // Wrap raw 32-byte keys in DER format for Node.js crypto API.
  const privKeyObj = createPrivateKey({
    key: Buffer.concat([
      Buffer.from('302e020100300506032b656e04220420', 'hex'), // PKCS8 X25519 prefix
      ourSecretKey,
    ]),
    format: 'der',
    type: 'pkcs8',
  })
  const pubKeyObj = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b656e032100', 'hex'), // SPKI X25519 prefix
      theirPublicKey,
    ]),
    format: 'der',
    type: 'spki',
  })

  const raw = diffieHellman({ privateKey: privKeyObj, publicKey: pubKeyObj })
  return hkdfSha256(raw, Buffer.from(E2E_KEY_DERIVATION_VERSION), KEY_LENGTH)
}

/** Generate a 32-byte random nonce for auth challenge, returned as base64. */
export function createAuthNonce(): string {
  return randomBytes(32).toString('base64')
}

/** Create an HMAC-SHA256 proof: HMAC(nonce, sharedSecret), returned as base64. */
export function createAuthProof(nonceB64: string, sharedSecret: Buffer): string {
  const nonce = Buffer.from(nonceB64, 'base64')
  return createHmac('sha256', sharedSecret).update(nonce).digest().toString('base64')
}

/** Verify an auth proof with constant-time comparison. */
export function verifyAuthProof(nonceB64: string, proofB64: string, sharedSecret: Buffer): boolean {
  const expected = createHmac('sha256', sharedSecret).update(Buffer.from(nonceB64, 'base64')).digest()
  const actual = Buffer.from(proofB64, 'base64')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}
