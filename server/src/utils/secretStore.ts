import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { hostname, userInfo } from 'os'
import { dirname, join } from 'path'
import { dataDir } from '../paths'
import { atomicWriteFileSync } from './atomicWrite'
import { warn as _warn, error as _error, log as _log } from '../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('secretStore', msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error('secretStore', msg, fields)
}
function log(msg: string, fields?: Record<string, unknown>): void {
  _log('secretStore', msg, fields)
}

// ---------------------------------------------------------------------------
// Lazy electron resolution.
//
// `app` and `safeStorage` exist only inside a real Electron runtime. A
// top-level `import { app, safeStorage } from 'electron'` makes every module
// that transitively imports this file (settings-store → tab-backend-merge →
// the prompt-pipeline test constellation) unloadable under plain-Node vitest
// with the electron binary absent (npm ci --ignore-scripts, as CI and the
// Linux parity gate run): require('electron') throws "Electron failed to
// install correctly" at import time. Resolution is deferred to first use;
// when electron is unavailable the caller falls back to Tier 2
// (keyfile AES-GCM), which is the correct behavior outside a
// packaged Electron app anyway.
// ---------------------------------------------------------------------------

type ElectronSecrets = {
  app: typeof import('electron').app
  safeStorage: typeof import('electron').safeStorage
}

let _electron: ElectronSecrets | null | undefined

function getElectron(): ElectronSecrets | null {
  if (_electron !== undefined) return _electron
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('electron') as Partial<ElectronSecrets>
    _electron = mod && typeof mod === 'object' && mod.app && mod.safeStorage
      ? { app: mod.app, safeStorage: mod.safeStorage }
      : null
  } catch {
    _electron = null
  }
  return _electron
}

/**
 * TEST ONLY. Inject an app/safeStorage stub so tier-1 paths run without a
 * real Electron runtime (vi.mock('electron') does not intercept the lazy
 * runtime require above). Pass undefined to reset to lazy resolution.
 */
export function _setElectronForTest(stub: ElectronSecrets | null | undefined): void {
  _electron = stub
}

// ---------------------------------------------------------------------------
// Encryption prefix tags
// ---------------------------------------------------------------------------

/** Electron safeStorage (Keychain-backed, production builds). */
const ENC_V1_PREFIX = 'enc:v1:'

/**
 * LEGACY, decrypt-only: machine-derived AES-GCM keyed from
 * SHA-256(hostname + username). The hostname component broke decryption
 * whenever DHCP/mDNS renamed the machine between boots, losing the stored
 * secrets. Values on disk written by earlier builds still carry this prefix,
 * so the decoder stays; writes now produce enc:v3: and
 * encryptSensitiveSettings upgrades v2 values on the next settings save.
 */
const ENC_V2_PREFIX = 'enc:v2:'

/** Keyfile-backed AES-GCM (dev / ad-hoc signed builds). */
const ENC_V3_PREFIX = 'enc:v3:'

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
//   Tier 2 — AES-256-GCM keyed by a random 256-bit key persisted in a 0600
//            keyfile (~/.ion/desktop-secrets.key). This is obfuscation, not
//            strong security — it prevents casual `cat` and scripted scraping
//            of settings.json, but won't stop a determined attacker with
//            local access (who could read the keyfile too). Used for dev
//            builds and any environment where safeStorage is unavailable.
//            Earlier builds derived this key from machine identity
//            (hostname + uid), which broke across hostname changes; that
//            derivation survives only as the enc:v2: decrypt fallback.
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
  const e = getElectron()
  if (!e) return false
  return e.app.isPackaged && e.safeStorage.isEncryptionAvailable()
}

// ---------------------------------------------------------------------------
// Keyfile-backed encryption (Tier 2, enc:v3:)
// ---------------------------------------------------------------------------

const CIPHER_ALG = 'aes-256-gcm'
const NONCE_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

/**
 * Default keyfile location; overridable for tests via _setKeyfilePathForTest.
 * Resolved fresh on every call, never cached at module scope: a top-level
 * `= join(dataDir(), ...)` runs the moment anything imports this file, which
 * breaks any bundle target that cannot run real Node fs/path/os at import
 * time (the Studio renderer imports the session store, which imports this
 * file transitively via settings-store.ts, purely to compile).
 */
let keyfilePathOverride: string | undefined
function keyfilePath(): string {
  return keyfilePathOverride ?? join(dataDir(), 'desktop-secrets.key')
}

/**
 * TEST ONLY. Redirect the keyfile to a temp location so tests never touch
 * the real ~/.ion. Pass undefined to restore the default path.
 */
export function _setKeyfilePathForTest(path: string | undefined): void {
  keyfilePathOverride = path
}

/**
 * Loads the 32-byte Tier-2 key from the keyfile, creating it with fresh
 * random bytes on first use. Creation uses the 'wx' flag (O_EXCL) so a
 * concurrent-process race resolves to one winner; the loser re-reads the
 * winner's key. A present-but-malformed keyfile throws rather than being
 * regenerated — regenerating would orphan every value encrypted under it.
 */
function loadOrCreateKeyfile(): Buffer {
  let raw: string | null = null
  try {
    raw = readFileSync(keyfilePath(), 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  if (raw !== null) {
    const key = Buffer.from(raw.trim(), 'hex')
    if (key.length !== KEY_LEN) {
      throw new Error(`keyfile ${keyfilePath()}: expected ${KEY_LEN}-byte key, got ${key.length} bytes`)
    }
    return key
  }

  const key = randomBytes(KEY_LEN)
  mkdirSync(dirname(keyfilePath()), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(keyfilePath(), key.toString('hex'), { mode: 0o600, flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Lost the creation race to another process; use its key.
      const existing = Buffer.from(readFileSync(keyfilePath(), 'utf-8').trim(), 'hex')
      if (existing.length !== KEY_LEN) {
        throw new Error(`keyfile ${keyfilePath()}: expected ${KEY_LEN}-byte key, got ${existing.length} bytes`)
      }
      return existing
    }
    throw err
  }
  log('created desktop secrets keyfile', { keyfilePath: keyfilePath() })
  return key
}

/**
 * LEGACY. Derives the pre-keyfile 32-byte AES key from machine identity
 * (SHA-256 of salt + hostname + username). Retained only to decrypt enc:v2:
 * values written by earlier builds — the hostname input made this derivation
 * break across reboots when the network renamed the machine.
 */
let hostnameFn: () => string = hostname

/** TEST ONLY. Override the hostname used by the legacy v2 key derivation. */
export function _setHostnameForTest(fn: (() => string) | undefined): void {
  hostnameFn = fn ?? hostname
}

function deriveLegacyMachineKey(): Buffer {
  const h = createHash('sha256')
  h.update('ion-desktop-secrets:')
  h.update(hostnameFn())
  h.update(':')
  try {
    h.update(userInfo().username)
  } catch {
    h.update('unknown')
  }
  return h.digest()
}

function aesGcmEncrypt(key: Buffer, plaintext: string): string {
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv(CIPHER_ALG, key, nonce, { authTagLength: TAG_LEN })
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Wire format: nonce (12) || tag (16) || ciphertext
  const combined = Buffer.concat([nonce, tag, encrypted])
  return combined.toString('base64')
}

function aesGcmDecrypt(key: Buffer, base64Payload: string): string {
  const raw = Buffer.from(base64Payload, 'base64')
  if (raw.length < NONCE_LEN + TAG_LEN) {
    throw new Error('encrypted value too short')
  }
  const nonce = raw.subarray(0, NONCE_LEN)
  const tag = raw.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN)
  const ciphertext = raw.subarray(NONCE_LEN + TAG_LEN)
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
 * Always keyfile AES-GCM (`enc:v3:…`). The Keychain tier (`enc:v1:…`) is
 * read-only legacy: see encryptForDisk's comment for why it was retired.
 */
export function encryptForDisk(plaintext: string): string {
  if (!plaintext) return plaintext
  // One tier for every writer. The store's owner is the Studio server, a
  // plain Node process that cannot reach Electron's safeStorage; a value the
  // desktop wrote with the Keychain (enc:v1) was unreadable to the process
  // that actually serves the paired devices, so pairing silently broke and
  // the server warned on every read. The keyfile tier is readable by both.
  // safeStorage now serves only to read legacy v1 values during migration
  // (see migrateLegacySafeStorageSecrets).
  return ENC_V3_PREFIX + aesGcmEncrypt(loadOrCreateKeyfile(), plaintext)
}

/**
 * Decrypts a value previously written by encryptForDisk.
 *
 * Handles four cases:
 *  - `enc:v1:…` — safeStorage (needs safeStorage available)
 *  - `enc:v3:…` — keyfile AES-GCM (always available)
 *  - `enc:v2:…` — legacy machine-derived AES-GCM (decrypt-only; upgraded to
 *    v3 by encryptSensitiveSettings on the next settings write)
 *  - no prefix  — legacy plaintext (returned as-is, will be encrypted on next write)
 */
/** Ciphertexts already warned about (see decryptFromDisk). */
const legacyValuesWarned = new Set<string>()

export function decryptFromDisk(value: string): string {
  if (!value) return value

  if (value.startsWith(ENC_V1_PREFIX)) {
    if (!isSafeStorageReady()) {
      // Once per distinct ciphertext per process: this fires on every read
      // of a legacy value in a process that cannot decrypt it, and a
      // paired-device check reads several values many times a minute.
      // Hundreds of identical lines a minute buried the one that mattered.
      if (!legacyValuesWarned.has(value)) {
        legacyValuesWarned.add(value)
        warn('found Keychain-encrypted (enc:v1) value this process cannot read; preserving ciphertext. The desktop migrates these to the shared keyfile tier at its next launch (migrateLegacySafeStorageSecrets); until then the value is unusable here.', { ciphertext_prefix: value.slice(0, 16) })
      }
      return value
    }
    try {
      const buf = Buffer.from(value.slice(ENC_V1_PREFIX.length), 'base64')
      return getElectron()!.safeStorage.decryptString(buf)
    } catch (err) {
      // Preserve the ciphertext so a load-then-save round trip cannot destroy
      // the recoverable on-disk value. decodeSharedSecret classifies any `enc:`
      // prefix as `encrypted` and refuses it before it reaches HMAC or AES-GCM,
      // so no wrong-length key can be used for transport authentication.
      // Keychain grants are bound to the code signature, so a desktop reinstall
      // can make decryptString throw here; the pairing remains unusable until
      // it is repaired, but its ciphertext remains available for recovery.
      error('safeStorage decrypt failed; preserving ciphertext, pairing marked unusable — re-pair the device', { error: String(err) })
      return value
    }
  }

  if (value.startsWith(ENC_V3_PREFIX)) {
    try {
      return aesGcmDecrypt(loadOrCreateKeyfile(), value.slice(ENC_V3_PREFIX.length))
    } catch (err) {
      error('keyfile decrypt failed; preserving ciphertext, pairing marked unusable — re-pair the device', { error: String(err) })
      return value
    }
  }

  if (value.startsWith(ENC_V2_PREFIX)) {
    try {
      return aesGcmDecrypt(deriveLegacyMachineKey(), value.slice(ENC_V2_PREFIX.length))
    } catch (err) {
      // The classic failure: the hostname changed since the value was
      // written, so the legacy machine-derived key no longer matches.
      warn('legacy machine-derived decrypt failed (hostname changed?); preserving ciphertext, pairing marked unusable — re-pair the device', { error: String(err) })
      return value
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
const SENSITIVE_DEVICE_FIELDS = ['sharedSecret', 'relayOidcSubject'] as const

/**
 * A settings document with every secret removed: the sensitive top-level
 * fields and each paired device's sensitive fields. For readers that may see
 * the server's settings but not the credentials in them.
 */
export function withoutSecrets(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...settings }
  for (const key of SENSITIVE_TOP_FIELDS) delete out[key]
  if (Array.isArray(out.pairedDevices)) {
    out.pairedDevices = out.pairedDevices.map((device: unknown) => {
      if (!device || typeof device !== 'object') return device
      const copy: Record<string, unknown> = { ...(device as Record<string, unknown>) }
      for (const key of SENSITIVE_DEVICE_FIELDS) delete copy[key]
      return copy
    })
  }
  return out
}

/** Returns true when `value` carries any encryption prefix. */
function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_V1_PREFIX) || value.startsWith(ENC_V2_PREFIX) || value.startsWith(ENC_V3_PREFIX)
}

/**
 * Re-encryptable: plaintext (no prefix) or a legacy enc:v2: value that
 * should be upgraded to the current scheme on the next write. enc:v2: is
 * upgraded eagerly because its machine-derived key dies with the next
 * hostname change — every settings save that leaves it in place is a
 * missed rescue.
 */
function needsWriteUpgrade(value: string): boolean {
  return !isEncrypted(value) || value.startsWith(ENC_V2_PREFIX)
}

/**
 * Produces the on-disk form of a sensitive value: plaintext is encrypted,
 * legacy enc:v2: is decrypted with the machine-derived key and re-encrypted
 * under the current scheme (v1 or v3). An undecryptable v2 value remains
 * ciphertext so a save cannot replace it with an empty value or re-encrypt it
 * as plaintext under a key that cannot decrypt it.
 */
function upgradeForDisk(value: string): string {
  const plaintext = value.startsWith(ENC_V2_PREFIX) ? decryptFromDisk(value) : value
  return isEncrypted(plaintext) ? plaintext : encryptForDisk(plaintext)
}

// encryptSensitiveSettings returns a copy of settings with sensitive fields
// replaced by their encrypted forms.
export function encryptSensitiveSettings(settings: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...settings }
  for (const key of SENSITIVE_TOP_FIELDS) {
    const v = out[key]
    // Empty values are intentionally left unchanged. They must never replace
    // preserved ciphertext during a load-then-save settings round trip.
    if (typeof v === 'string' && v && needsWriteUpgrade(v)) {
      out[key] = upgradeForDisk(v)
    }
  }
  if (Array.isArray(out.pairedDevices)) {
    out.pairedDevices = out.pairedDevices.map((device: any) => {
      if (!device || typeof device !== 'object') return device
      const next = { ...device }
      for (const key of SENSITIVE_DEVICE_FIELDS) {
        const v = next[key]
        // Empty values are intentionally left unchanged. They must never
        // replace preserved ciphertext during a load-then-save round trip.
        if (typeof v === 'string' && v && needsWriteUpgrade(v)) {
          next[key] = upgradeForDisk(v)
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

// ---------------------------------------------------------------------------
// Legacy Keychain (enc:v1) migration
// ---------------------------------------------------------------------------

export interface LegacySecretMigrationReport {
  /** Files inspected (those present on disk). */
  files: string[]
  /** enc:v1 values rewritten as enc:v3. */
  rewritten: number
  /** enc:v1 values found but left in place because they could not be decrypted here. */
  unreadable: number
  /** Whether safeStorage was available to this process. */
  safeStorageReady: boolean
}

/** Every string leaf under `value` that carries the legacy Keychain prefix, re-encrypted under the keyfile tier where this process can read it. */
export function reencryptLegacySafeStorageValues(value: unknown, counters: { rewritten: number; unreadable: number }): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith(ENC_V1_PREFIX)) return value
    const e = getElectron()
    if (!e || !isSafeStorageReady()) {
      counters.unreadable += 1
      return value
    }
    try {
      const plaintext = e.safeStorage.decryptString(Buffer.from(value.slice(ENC_V1_PREFIX.length), 'base64'))
      counters.rewritten += 1
      return ENC_V3_PREFIX + aesGcmEncrypt(loadOrCreateKeyfile(), plaintext)
    } catch (err) {
      // A Keychain grant bound to a previous code signature: the value is
      // gone for good, but the ciphertext is preserved so nothing overwrites
      // it with an empty string.
      error('legacy Keychain value could not be decrypted during migration; preserving ciphertext', { error: String(err) })
      counters.unreadable += 1
      return value
    }
  }
  if (Array.isArray(value)) return value.map((item) => reencryptLegacySafeStorageValues(item, counters))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = reencryptLegacySafeStorageValues(v, counters)
    return out
  }
  return value
}

/** The files under the data dir that hold sensitive values. */
export function legacySecretFiles(dir: string = dataDir()): string[] {
  return ['settings.json', 'credentials.json', 'browser-sessions.json'].map((name) => join(dir, name))
}

/**
 * Rewrite every legacy Keychain-encrypted value in the data dir's secret
 * files under the shared keyfile tier.
 *
 * Only a packaged Electron process can decrypt enc:v1 (the Keychain grant
 * is bound to the desktop's code signature), so the desktop runs this once
 * per launch BEFORE it spawns the Studio server -- the server owns these
 * files from then on, and two writers would race. Outside Electron the
 * function only counts what it cannot read. Files are written atomically
 * with mode 0600, and a file with nothing to rewrite is left untouched.
 */
export function migrateLegacySafeStorageSecrets(dir: string = dataDir()): LegacySecretMigrationReport {
  const report: LegacySecretMigrationReport = { files: [], rewritten: 0, unreadable: 0, safeStorageReady: isSafeStorageReady() }
  for (const file of legacySecretFiles(dir)) {
    if (!existsSync(file)) continue
    report.files.push(file)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf-8'))
    } catch (err) {
      error('legacy secret migration: file is not valid JSON; skipped', { file, error: String(err) })
      continue
    }
    const counters = { rewritten: 0, unreadable: 0 }
    const next = reencryptLegacySafeStorageValues(parsed, counters)
    report.rewritten += counters.rewritten
    report.unreadable += counters.unreadable
    if (counters.rewritten > 0) {
      atomicWriteFileSync(file, JSON.stringify(next, null, 2), 0o600)
      log('legacy secret migration: rewrote Keychain values under the keyfile tier', { file, rewritten: counters.rewritten, unreadable: counters.unreadable })
    } else if (counters.unreadable > 0) {
      warn('legacy secret migration: Keychain values present but not readable in this process', { file, unreadable: counters.unreadable, safe_storage_ready: report.safeStorageReady })
    }
  }
  return report
}
