/**
 * Paired-device shared-secret decoding, with a validity guard.
 *
 * Every consumer of `PairedDevice.sharedSecret` used to call
 * `Buffer.from(device.sharedSecret, 'base64')` directly. That is unsafe as a
 * trust boundary: Node's base64 decoder never throws. It silently skips any
 * character outside the base64 alphabet, so a corrupt record — most notably
 * one still carrying its `enc:v1:` at-rest prefix because safeStorage could
 * not decrypt it — decodes to a short, wrong-valued Buffer instead of failing.
 *
 * The consequences were invisible at the point of failure and misleading
 * everywhere else:
 *   - HMAC (LAN auth proof) accepts a key of ANY length, so a corrupt secret
 *     failed as "invalid proof" — indistinguishable from an attacker.
 *   - AES-256-GCM requires exactly 32 bytes, so frames failed as "Decryption
 *     failed (wrong key, tampered, or wrong nonce)".
 *   - The device was still present in the registry with a non-empty
 *     `sharedSecret` field, so every diagnostic said the pairing was intact.
 *
 * A shared secret is HKDF-SHA256 output at KEY_LENGTH (32) bytes. Anything
 * else is not a usable key, and this module is the single place that decides
 * so.
 */

import { KEY_LENGTH } from './crypto-core'

/** Why a stored shared secret could not be used. */
export type SecretDecodeFailure =
  /** Field absent or empty — the record genuinely has no stored secret. */
  | 'missing'
  /**
   * Still carrying an at-rest encryption prefix (`enc:v1:` / `enc:v2:` /
   * `enc:v3:`). The secret store preserves ciphertext when decryption fails,
   * which means the value could not be decrypted on this machine. This is the
   * expected state after a Keychain grant loss until the device is re-paired.
   */
  | 'encrypted'
  /** Decoded, but not the 32 bytes an AES-256/HKDF key must be. */
  | 'wrong-length'

export type SecretDecodeResult =
  | { ok: true; secret: Buffer }
  | { ok: false; reason: SecretDecodeFailure; byteLength: number }

/**
 * Any at-rest prefix written by `utils/secretStore`. A decrypted value never
 * retains one, so its presence here proves the value never came back from
 * `decryptFromDisk` in usable form.
 */
const AT_REST_PREFIXES = ['enc:v1:', 'enc:v2:', 'enc:v3:'] as const

/** True when the value still carries a secret-store at-rest prefix. */
export function looksEncrypted(value: string): boolean {
  return AT_REST_PREFIXES.some((p) => value.startsWith(p))
}

/**
 * Decode a stored base64 shared secret into a usable AES-256/HMAC key.
 *
 * Returns a discriminated result rather than throwing or returning a
 * best-effort Buffer, so every call site is forced to decide what to do with
 * an unusable pairing instead of silently proceeding with a wrong key.
 */
export function decodeSharedSecret(raw: string | undefined | null): SecretDecodeResult {
  if (!raw) return { ok: false, reason: 'missing', byteLength: 0 }

  if (looksEncrypted(raw)) {
    // Do not attempt to decode: base64 would succeed on the prefixed string
    // and produce exactly the wrong-key state this guard exists to stop.
    return { ok: false, reason: 'encrypted', byteLength: 0 }
  }

  const buf = Buffer.from(raw, 'base64')
  if (buf.length !== KEY_LENGTH) {
    return { ok: false, reason: 'wrong-length', byteLength: buf.length }
  }

  return { ok: true, secret: buf }
}

/**
 * Human-readable explanation for a decode failure, for logs and for the
 * refusal reason sent to the client.
 */
export function describeSecretFailure(reason: SecretDecodeFailure): string {
  switch (reason) {
    case 'missing':
      return 'stored pairing has no shared secret'
    case 'encrypted':
      return 'stored pairing secret could not be decrypted on this machine'
    case 'wrong-length':
      return 'stored pairing secret is not a valid 32-byte key'
  }
}
