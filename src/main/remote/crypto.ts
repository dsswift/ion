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

import { randomBytes, createCipheriv, createDecipheriv, createHmac, createHash, generateKeyPairSync, diffieHellman, createPublicKey, createPrivateKey, timingSafeEqual } from 'crypto'
import { log as _log } from '../logger'

function log(msg: string): void {
  _log('Crypto', msg)
}

const KEY_LENGTH = 32
const NONCE_LENGTH = 12 // AES-256-GCM uses 12-byte nonce (recommended)
const TAG_LENGTH = 16   // GCM auth tag
const CIPHER_ALG = 'aes-256-gcm' as const

/** Generate a random 256-bit key. */
export function generateKey(): Buffer {
  return randomBytes(KEY_LENGTH)
}

/** Generate a random 12-byte nonce for ChaCha20-Poly1305. */
export function generateNonce(): Buffer {
  return randomBytes(NONCE_LENGTH)
}

/** Generate a 256-bit device token. */
export function generateDeviceToken(): Buffer {
  return randomBytes(32)
}

/**
 * Derive a channel ID from the shared secret.
 * First 16 bytes of SHA-256(key), hex-encoded (32 hex chars).
 * Matches iOS E2ECrypto.deriveChannelId().
 */
export function deriveChannelId(sharedSecret: Buffer): string {
  const hash = createHash('sha256').update(sharedSecret).digest()
  return hash.subarray(0, 16).toString('hex')
}

/**
 * Encrypt a plaintext payload with AES-256-GCM.
 *
 * Returns { nonce, ciphertext } both as base64 strings.
 * The ciphertext includes the 16-byte GCM auth tag appended.
 * This matches iOS CryptoKit AES.GCM.seal() output format.
 */
export function encrypt(plaintext: string, key: Buffer): { nonce: string; ciphertext: string } {
  const nonce = generateNonce()
  const plaintextBuf = Buffer.from(plaintext, 'utf-8')

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
 * Decrypt an AES-256-GCM ciphertext.
 *
 * Expects ciphertext with the 16-byte auth tag appended (same format
 * as iOS CryptoKit AES.GCM.SealedBox).
 *
 * Returns the plaintext string, or null if decryption fails
 * (tampered, wrong key, or wrong nonce).
 */
export function decrypt(nonceB64: string, ciphertextB64: string, key: Buffer): string | null {
  const nonce = Buffer.from(nonceB64, 'base64')
  const combined = Buffer.from(ciphertextB64, 'base64')

  if (nonce.length !== NONCE_LENGTH) {
    log(`Invalid nonce length: ${nonce.length} (expected ${NONCE_LENGTH})`)
    return null
  }

  if (combined.length < TAG_LENGTH) {
    log(`Ciphertext too short: ${combined.length} bytes`)
    return null
  }

  // Split ciphertext and auth tag
  const ciphertext = combined.subarray(0, combined.length - TAG_LENGTH)
  const tag = combined.subarray(combined.length - TAG_LENGTH)

  try {
    const decipher = createDecipheriv(CIPHER_ALG, key, nonce, { authTagLength: TAG_LENGTH })
    decipher.setAuthTag(tag)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return decrypted.toString('utf-8')
  } catch {
    log('Decryption failed (wrong key, tampered, or wrong nonce)')
    return null
  }
}

/**
 * X25519 key pair generation for Diffie-Hellman key exchange during pairing.
 *
 * Returns { publicKey, secretKey } as raw 32-byte Buffers.
 * Uses Node.js crypto.generateKeyPairSync('x25519').
 */
export function generateKeyPair(): { publicKey: Buffer; secretKey: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(12)),
    secretKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(16)),
  }
}

/**
 * Derive a shared secret from our secret key and the peer's public key.
 *
 * Uses HKDF-SHA256 with info "coda-remote-v1" to produce a 32-byte key.
 * Matches iOS CryptoKit HKDF derivation.
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
  return hkdfSha256(raw, Buffer.from('coda-remote-v1'), KEY_LENGTH)
}

// ─── Auth handshake helpers ───

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

/** Simple HKDF-SHA256 extract + expand (RFC 5869). */
function hkdfSha256(ikm: Buffer, info: Buffer, length: number): Buffer {
  // Extract: PRK = HMAC-SHA256(salt=zeros, IKM)
  const prk = createHmac('sha256', Buffer.alloc(32, 0)).update(ikm).digest()
  // Expand: T(1) = HMAC-SHA256(PRK, info || 0x01) -- single round since length <= 32
  const t = createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest()
  return t.subarray(0, length)
}
