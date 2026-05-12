import { app, safeStorage } from 'electron'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { hostname, userInfo } from 'os'

// ---------------------------------------------------------------------------
// Encryption prefix tags
// ---------------------------------------------------------------------------

/** Electron safeStorage (Keychain-backed, production builds). */
const ENC_V1_PREFIX = 'enc:v1:'

/** Machine-derived AES-GCM (dev / ad-hoc signed builds). */
const ENC_V2_PREFIX = 'enc:v2:'

// ---------------------------------------------------------------------------
// Tier detection
// ---------------------------------------------------------------------------

// The desktop secret store uses two tiers of at-rest encryption:
//
//   Tier 1 — Electron safeStorage (macOS Keychain / Windows DPAPI / libsecret).
//            Available only in properly code-signed, packaged builds. When the
//            app is ad-hoc signed (local dev builds, cloned-and-built from
//            source), every rebuild invalidates the Keychain grant and macOS
//            prompts the user for their login password — which blocks the main
//            process and freezes the app. So we only use safeStorage when the
//            app is packaged with a stable code signature.
//
//   Tier 2 — Machine-derived AES-256-GCM, keyed from SHA-256(hostname + uid).
//            This is obfuscation, not strong security — it prevents casual
//            `cat` and scripted scraping of settings.json, but won't stop a
//            determined attacker with local access. Used for dev builds and
//            any environment where safeStorage is unavailable.
//
// Both tiers protect the same fields: relayApiKey and pairedDevices[].sharedSecret.
// Engine API keys (ANTHROPIC_API_KEY, etc.) are deliberately NOT managed here —
// the engine's auth resolver lets developers provide those however they want
// (env vars, mounted secrets, vault, keychain).

/**
 * Returns true when Electron's Keychain-backed safeStorage can be used without
 * triggering a password prompt on every rebuild.
 *
 * Conditions:
 *  - `app.isPackaged` — the build was produced by electron-builder with a
 *    stable code signature, so the Keychain grant persists across launches.
 *  - `safeStorage.isAvailable()` — the backend is actually functional.
 */
export function isSafeStorageReady(): boolean {
  return app.isPackaged && safeStorage.isEncryptionAvailable()
}

// ---------------------------------------------------------------------------
// Machine-derived encryption (Tier 2)
// ---------------------------------------------------------------------------

const CIPHER_ALG = 'aes-256-gcm'
const NONCE_LEN = 12
const TAG_LEN = 16

/**
 * Derives a 32-byte AES key from machine identity. Uses the same approach as
 * the engine's FileStore (engine/internal/auth/filestore.go): SHA-256 of a
 * salt + hostname + username. Basic obfuscation — stops `cat`, not a forensic
 * examiner.
 */
function deriveMachineKey(): Buffer {
  const h = createHash('sha256')
  h.update('ion-desktop-secrets:')
  h.update(hostname())
  h.update(':')
  try {
    h.update(userInfo().username)
  } catch {
    h.update('unknown')
  }
  return h.digest()
}

function machineEncrypt(plaintext: string): string {
  const key = deriveMachineKey()
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv(CIPHER_ALG, key, nonce, { authTagLength: TAG_LEN })
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Wire format: nonce (12) || tag (16) || ciphertext
  const combined = Buffer.concat([nonce, tag, encrypted])
  return ENC_V2_PREFIX + combined.toString('base64')
}

function machineDecrypt(value: string): string {
  const raw = Buffer.from(value.slice(ENC_V2_PREFIX.length), 'base64')
  if (raw.length < NONCE_LEN + TAG_LEN) {
    throw new Error('machine-encrypted value too short')
  }
  const nonce = raw.subarray(0, NONCE_LEN)
  const tag = raw.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN)
  const ciphertext = raw.subarray(NONCE_LEN + TAG_LEN)
  const key = deriveMachineKey()
  const decipher = createDecipheriv(CIPHER_ALG, key, nonce, { authTagLength: TAG_LEN })
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final('utf-8')
}

// ---------------------------------------------------------------------------
// Unified encrypt / decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypts a plaintext value for on-disk storage.
 *
 * - Production (packaged + signed): uses Electron safeStorage → `enc:v1:…`
 * - Dev / ad-hoc signed: uses machine-derived AES-GCM → `enc:v2:…`
 */
export function encryptForDisk(plaintext: string): string {
  if (!plaintext) return plaintext
  if (isSafeStorageReady()) {
    const buf = safeStorage.encryptString(plaintext)
    return ENC_V1_PREFIX + buf.toString('base64')
  }
  return machineEncrypt(plaintext)
}

/**
 * Decrypts a value previously written by encryptForDisk.
 *
 * Handles three cases:
 *  - `enc:v1:…` — safeStorage (needs safeStorage available)
 *  - `enc:v2:…` — machine-derived AES-GCM (always available)
 *  - no prefix  — legacy plaintext (returned as-is, will be encrypted on next write)
 */
export function decryptFromDisk(value: string): string {
  if (!value) return value

  if (value.startsWith(ENC_V1_PREFIX)) {
    if (!isSafeStorageReady()) {
      console.warn(
        '[secretStore] found safeStorage-encrypted value but safeStorage unavailable; value cleared — re-enter in settings',
      )
      return ''
    }
    try {
      const buf = Buffer.from(value.slice(ENC_V1_PREFIX.length), 'base64')
      return safeStorage.decryptString(buf)
    } catch {
      return value
    }
  }

  if (value.startsWith(ENC_V2_PREFIX)) {
    try {
      return machineDecrypt(value)
    } catch {
      console.warn('[secretStore] machine-decrypt failed; value cleared — re-enter in settings')
      return ''
    }
  }

  // No prefix → legacy plaintext; will be encrypted on next write cycle.
  return value
}

// ---------------------------------------------------------------------------
// Field-level application
// ---------------------------------------------------------------------------

// SENSITIVE_TOP_FIELDS lists settings keys whose top-level string value must
// be encrypted on disk.
const SENSITIVE_TOP_FIELDS = ['relayApiKey'] as const

// SENSITIVE_DEVICE_FIELDS lists fields on each entry of pairedDevices[] that
// must be encrypted on disk.
const SENSITIVE_DEVICE_FIELDS = ['sharedSecret'] as const

/** Returns true when `value` carries any encryption prefix. */
function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_V1_PREFIX) || value.startsWith(ENC_V2_PREFIX)
}

// encryptSensitiveSettings returns a copy of settings with sensitive fields
// replaced by their encrypted forms.
export function encryptSensitiveSettings(settings: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...settings }
  for (const key of SENSITIVE_TOP_FIELDS) {
    const v = out[key]
    if (typeof v === 'string' && v && !isEncrypted(v)) {
      out[key] = encryptForDisk(v)
    }
  }
  if (Array.isArray(out.pairedDevices)) {
    out.pairedDevices = out.pairedDevices.map((device: any) => {
      if (!device || typeof device !== 'object') return device
      const next = { ...device }
      for (const key of SENSITIVE_DEVICE_FIELDS) {
        const v = next[key]
        if (typeof v === 'string' && v && !isEncrypted(v)) {
          next[key] = encryptForDisk(v)
        }
      }
      return next
    })
  }
  delete out.secret_unencrypted
  return out
}

// decryptSensitiveSettings returns a copy of settings with sensitive fields
// replaced by their plaintext forms.
export function decryptSensitiveSettings(settings: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...settings }
  for (const key of SENSITIVE_TOP_FIELDS) {
    const v = out[key]
    if (typeof v === 'string' && isEncrypted(v)) {
      out[key] = decryptFromDisk(v)
    }
  }
  if (Array.isArray(out.pairedDevices)) {
    out.pairedDevices = out.pairedDevices.map((device: any) => {
      if (!device || typeof device !== 'object') return device
      const next = { ...device }
      for (const key of SENSITIVE_DEVICE_FIELDS) {
        const v = next[key]
        if (typeof v === 'string' && isEncrypted(v)) {
          next[key] = decryptFromDisk(v)
        }
      }
      return next
    })
  }
  return out
}
