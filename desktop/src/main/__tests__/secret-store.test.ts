/**
 * Secret Store Tests
 *
 * Tests for the two-tier encryption system in secretStore.ts.
 * Tier 1 (safeStorage) is mocked since it requires Electron's main process.
 * Tier 2 (keyfile AES-GCM, enc:v3:) and the legacy machine-derived decrypt
 * fallback (enc:v2:) are tested directly.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, it, expect, beforeEach, afterAll } from 'vitest'

// ---------------------------------------------------------------------------
// Inject an Electron app/safeStorage stub via the module's test seam.
// secretStore resolves electron lazily with require() (so plain-Node vitest
// can load it without the electron binary), which vi.mock('electron') does
// not intercept — the seam is the supported injection point.
// ---------------------------------------------------------------------------

let mockIsPackaged = false
let mockSafeStorageAvailable = false
let mockSafeStorageDecryptError: Error | null = null
const mockEncryptedValues = new Map<string, Buffer>()

import {
  isSafeStorageReady,
  encryptForDisk,
  decryptFromDisk,
  encryptSensitiveSettings,
  decryptSensitiveSettings,
  _setElectronForTest,
  _setKeyfilePathForTest,
  _setHostnameForTest,
} from '../utils/secretStore'

_setElectronForTest({
  app: {
    get isPackaged() {
      return mockIsPackaged
    },
  } as unknown as typeof import('electron').app,
  safeStorage: {
    isEncryptionAvailable: () => mockSafeStorageAvailable,
    encryptString: (plaintext: string) => {
      // Simulate safeStorage by storing the value and returning a deterministic buffer
      const buf = Buffer.from(`safe:${plaintext}`)
      mockEncryptedValues.set(plaintext, buf)
      return buf
    },
    decryptString: (buf: Buffer) => {
      if (mockSafeStorageDecryptError) throw mockSafeStorageDecryptError
      const str = buf.toString()
      if (!str.startsWith('safe:')) throw new Error('invalid safeStorage ciphertext')
      return str.slice(5)
    },
  } as unknown as typeof import('electron').safeStorage,
})

// ---------------------------------------------------------------------------
// Keyfile redirection — tests never touch the real ~/.ion.
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), 'secret-store-test-'))
const testKeyfile = join(testDir, 'desktop-secrets.key')
_setKeyfilePathForTest(testKeyfile)

afterAll(() => {
  _setKeyfilePathForTest(undefined)
  _setHostnameForTest(undefined)
  rmSync(testDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockIsPackaged = false
  mockSafeStorageAvailable = false
  mockSafeStorageDecryptError = null
  mockEncryptedValues.clear()
  _setHostnameForTest(undefined)
})

/**
 * Produces an enc:v2: value exactly as a pre-keyfile build would have
 * written it: AES-256-GCM keyed from SHA-256(salt + hostname + username),
 * wire format nonce(12) || tag(16) || ciphertext.
 */
function legacyV2Encrypt(plaintext: string, hostnameOverride?: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createCipheriv, createHash, randomBytes } = require('crypto') as typeof import('crypto')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { hostname, userInfo } = require('os') as typeof import('os')
  const h = createHash('sha256')
  h.update('ion-desktop-secrets:')
  h.update(hostnameOverride ?? hostname())
  h.update(':')
  try {
    h.update(userInfo().username)
  } catch {
    h.update('unknown')
  }
  const key = h.digest()
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 })
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return 'enc:v2:' + Buffer.concat([nonce, tag, encrypted]).toString('base64')
}

// ---------------------------------------------------------------------------
// isSafeStorageReady
// ---------------------------------------------------------------------------

describe('isSafeStorageReady', () => {
  it('returns false in dev builds (not packaged)', () => {
    mockIsPackaged = false
    mockSafeStorageAvailable = true
    expect(isSafeStorageReady()).toBe(false)
  })

  it('returns false when packaged but safeStorage unavailable', () => {
    mockIsPackaged = true
    mockSafeStorageAvailable = false
    expect(isSafeStorageReady()).toBe(false)
  })

  it('returns true when packaged AND safeStorage available', () => {
    mockIsPackaged = true
    mockSafeStorageAvailable = true
    expect(isSafeStorageReady()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Tier 2: keyfile encryption (dev builds, enc:v3:)
// ---------------------------------------------------------------------------

describe('keyfile encryption (tier 2, enc:v3:)', () => {
  it('encrypts with enc:v3: prefix in dev builds', () => {
    const encrypted = encryptForDisk('my-secret-key')
    expect(encrypted.startsWith('enc:v3:')).toBe(true)
    expect(encrypted).not.toContain('my-secret-key')
  })

  it('round-trips through encrypt → decrypt', () => {
    const plaintext = 'relay-api-key-12345'
    const encrypted = encryptForDisk(plaintext)
    const decrypted = decryptFromDisk(encrypted)
    expect(decrypted).toBe(plaintext)
  })

  it('creates the keyfile with 0600 permissions and a 32-byte hex key', () => {
    encryptForDisk('force-keyfile-creation')
    expect(existsSync(testKeyfile)).toBe(true)
    const mode = statSync(testKeyfile).mode & 0o777
    expect(mode).toBe(0o600)
    const key = Buffer.from(readFileSync(testKeyfile, 'utf-8').trim(), 'hex')
    expect(key.length).toBe(32)
  })

  it('produces different ciphertext for the same plaintext (random nonce)', () => {
    const a = encryptForDisk('same-value')
    const b = encryptForDisk('same-value')
    expect(a).not.toBe(b)
    // But both decrypt to the same value
    expect(decryptFromDisk(a)).toBe('same-value')
    expect(decryptFromDisk(b)).toBe('same-value')
  })

  it('handles empty string', () => {
    expect(encryptForDisk('')).toBe('')
    expect(decryptFromDisk('')).toBe('')
  })

  it('handles unicode content', () => {
    const plaintext = '日本語のAPIキー🔑'
    const encrypted = encryptForDisk(plaintext)
    expect(decryptFromDisk(encrypted)).toBe(plaintext)
  })

  it('preserves corrupted v3 ciphertext', () => {
    const ciphertext = 'enc:v3:' + Buffer.alloc(40, 7).toString('base64')
    expect(decryptFromDisk(ciphertext)).toBe(ciphertext)
  })

  it('preserves truncated v3 ciphertext', () => {
    const ciphertext = 'enc:v3:AAAA'
    expect(decryptFromDisk(ciphertext)).toBe(ciphertext)
  })

  it('REGRESSION: v3 values survive a hostname change (the lost-API-key bug)', () => {
    _setHostnameForTest(() => 'host-a.local')
    const encrypted = encryptForDisk('survives-reboot')
    // Simulate the reboot renaming the machine (DHCP/mDNS rename).
    _setHostnameForTest(() => 'host-b-2.lan')
    expect(decryptFromDisk(encrypted)).toBe('survives-reboot')
  })
})

// ---------------------------------------------------------------------------
// Legacy enc:v2: (machine-derived) decrypt fallback
// ---------------------------------------------------------------------------

describe('legacy machine-derived values (enc:v2:)', () => {
  it('decrypts v2 values written under the current hostname', () => {
    const v2 = legacyV2Encrypt('legacy-relay-key')
    expect(decryptFromDisk(v2)).toBe('legacy-relay-key')
  })

  it('preserves v2 values when the hostname has changed', () => {
    const v2 = legacyV2Encrypt('sealed-under-old-host', 'old-hostname.local')
    // Current hostname differs from 'old-hostname.local' → legacy key mismatch.
    expect(decryptFromDisk(v2)).toBe(v2)
  })

  it('upgrades v2 values to v3 on encryptSensitiveSettings (write path)', () => {
    const v2 = legacyV2Encrypt('upgrade-me')
    const out = encryptSensitiveSettings({ relayApiKey: v2 })
    expect(out.relayApiKey.startsWith('enc:v3:')).toBe(true)
    expect(decryptFromDisk(out.relayApiKey)).toBe('upgrade-me')
  })

  it('upgrades v2 device sharedSecrets to v3 on encryptSensitiveSettings', () => {
    const v2 = legacyV2Encrypt('device-secret')
    const out = encryptSensitiveSettings({
      pairedDevices: [{ id: 'dev1', name: 'iPhone', sharedSecret: v2 }],
    })
    expect(out.pairedDevices[0].sharedSecret.startsWith('enc:v3:')).toBe(true)
    expect(decryptFromDisk(out.pairedDevices[0].sharedSecret)).toBe('device-secret')
  })

  it('preserves an undecryptable v2 value on write upgrade', () => {
    const v2 = legacyV2Encrypt('lost-forever', 'some-other-host')
    const out = encryptSensitiveSettings({ relayApiKey: v2 })
    expect(out.relayApiKey).toBe(v2)
  })
})

// ---------------------------------------------------------------------------
// Tier 1: safeStorage (production builds)
// ---------------------------------------------------------------------------

describe('safeStorage encryption (tier 1)', () => {
  beforeEach(() => {
    mockIsPackaged = true
    mockSafeStorageAvailable = true
  })

  it('encrypts with enc:v1: prefix when safeStorage is ready', () => {
    const encrypted = encryptForDisk('prod-secret')
    expect(encrypted.startsWith('enc:v1:')).toBe(true)
  })

  it('round-trips through safeStorage encrypt → decrypt', () => {
    const encrypted = encryptForDisk('prod-relay-key')
    const decrypted = decryptFromDisk(encrypted)
    expect(decrypted).toBe('prod-relay-key')
  })

  it('preserves v1 values when safeStorage becomes unavailable', () => {
    const encrypted = encryptForDisk('ephemeral-secret')
    expect(encrypted.startsWith('enc:v1:')).toBe(true)

    // Simulate switching to dev build
    mockIsPackaged = false
    expect(decryptFromDisk(encrypted)).toBe(encrypted)
  })

  it('preserves a v1 value when safeStorage decrypt throws', () => {
    const ciphertext = 'enc:v1:' + Buffer.from('safe-storage-ciphertext').toString('base64')
    mockSafeStorageDecryptError = new Error('Keychain grant unavailable')

    expect(decryptFromDisk(ciphertext)).toBe(ciphertext)
  })

  it('preserves ciphertext through a failed-decrypt settings round trip', () => {
    const ciphertext = 'enc:v1:' + Buffer.from('pairing-ciphertext').toString('base64')
    mockSafeStorageDecryptError = new Error('Keychain grant unavailable')
    const loaded = decryptSensitiveSettings({
      themeMode: 'dark',
      pairedDevices: [{ id: 'device-id', sharedSecret: ciphertext }],
    })
    const persisted = encryptSensitiveSettings({ ...loaded, themeMode: 'light' })

    expect(persisted.themeMode).toBe('light')
    expect(persisted.pairedDevices[0].sharedSecret).toBe(ciphertext)
  })

  it('does not replace preserved ciphertext with an empty sharedSecret', () => {
    const ciphertext = 'enc:v1:' + Buffer.from('pairing-ciphertext').toString('base64')
    mockSafeStorageDecryptError = new Error('Keychain grant unavailable')
    const loaded = decryptSensitiveSettings({
      pairedDevices: [{ id: 'device-id', sharedSecret: ciphertext }],
    })

    expect(loaded.pairedDevices[0].sharedSecret).toBe(ciphertext)
    expect(encryptSensitiveSettings(loaded).pairedDevices[0].sharedSecret).toBe(ciphertext)
  })

  it('retains an undecryptable device sharedSecret as ciphertext', () => {
    const foreign = 'enc:v1:' + Buffer.from('stale-keychain-blob').toString('base64')

    const out = decryptSensitiveSettings({
      pairedDevices: [{ id: 'dev-1', name: 'iPhone', sharedSecret: foreign }],
    })

    expect(out.pairedDevices[0].sharedSecret).toBe(foreign)
  })
})

// ---------------------------------------------------------------------------
// Legacy plaintext migration
// ---------------------------------------------------------------------------

describe('legacy plaintext handling', () => {
  it('returns plaintext as-is from decryptFromDisk (no prefix)', () => {
    expect(decryptFromDisk('old-plaintext-key')).toBe('old-plaintext-key')
  })

  it('encrypts plaintext values on next write via encryptSensitiveSettings', () => {
    const settings = {
      themeMode: 'dark',
      relayApiKey: 'old-plaintext-relay-key',
      pairedDevices: [
        { id: 'dev1', name: 'iPhone', sharedSecret: 'old-plaintext-secret' },
      ],
    }
    const encrypted = encryptSensitiveSettings(settings)
    // relayApiKey should now be encrypted
    expect(encrypted.relayApiKey).not.toBe('old-plaintext-relay-key')
    expect(encrypted.relayApiKey.startsWith('enc:v3:')).toBe(true)
    // sharedSecret should now be encrypted
    expect(encrypted.pairedDevices[0].sharedSecret).not.toBe('old-plaintext-secret')
    expect(encrypted.pairedDevices[0].sharedSecret.startsWith('enc:v3:')).toBe(true)
    // Non-sensitive fields unchanged
    expect(encrypted.themeMode).toBe('dark')
    expect(encrypted.pairedDevices[0].id).toBe('dev1')
    expect(encrypted.pairedDevices[0].name).toBe('iPhone')
  })
})

// ---------------------------------------------------------------------------
// encryptSensitiveSettings / decryptSensitiveSettings
// ---------------------------------------------------------------------------

describe('encryptSensitiveSettings', () => {
  it('does not double-encrypt already-encrypted values', () => {
    const first = encryptSensitiveSettings({ relayApiKey: 'test-key' })
    const second = encryptSensitiveSettings(first)
    expect(second.relayApiKey).toBe(first.relayApiKey)
  })

  it('passes enc:v1 and enc:v3 values through byte-identically', () => {
    mockIsPackaged = true
    mockSafeStorageAvailable = true
    const v1 = encryptForDisk('safe-storage-value')
    mockIsPackaged = false
    const v3 = encryptForDisk('keyfile-value')

    const persisted = encryptSensitiveSettings({
      relayApiKey: v1,
      pairedDevices: [{ id: 'device-id', sharedSecret: v3 }],
    })

    expect(persisted.relayApiKey).toBe(v1)
    expect(persisted.pairedDevices[0].sharedSecret).toBe(v3)
  })

  it('persists a normal update after successful decrypt', () => {
    mockIsPackaged = true
    mockSafeStorageAvailable = true
    const encrypted = encryptSensitiveSettings({
      themeMode: 'dark',
      pairedDevices: [{ id: 'device-id', sharedSecret: 'shared-secret-value' }],
    })
    const loaded = decryptSensitiveSettings(encrypted)
    const persisted = encryptSensitiveSettings({ ...loaded, themeMode: 'light' })

    expect(persisted.themeMode).toBe('light')
    expect(decryptSensitiveSettings(persisted).pairedDevices[0].sharedSecret).toBe('shared-secret-value')
  })

  it('removes secret_unencrypted flag', () => {
    const settings = { relayApiKey: 'key', secret_unencrypted: true }
    const result = encryptSensitiveSettings(settings)
    expect(result.secret_unencrypted).toBeUndefined()
  })

  it('handles missing pairedDevices gracefully', () => {
    const result = encryptSensitiveSettings({ relayApiKey: 'key' })
    expect(result.pairedDevices).toBeUndefined()
  })

  it('handles empty pairedDevices array', () => {
    const result = encryptSensitiveSettings({ pairedDevices: [] })
    expect(result.pairedDevices).toEqual([])
  })

  it('skips null entries in pairedDevices', () => {
    const result = encryptSensitiveSettings({ pairedDevices: [null, undefined] })
    expect(result.pairedDevices).toEqual([null, undefined])
  })
})

describe('decryptSensitiveSettings', () => {
  it('round-trips through encrypt → decrypt', () => {
    const original = {
      themeMode: 'dark',
      relayApiKey: 'my-relay-key',
      pairedDevices: [
        { id: 'dev1', name: 'Phone', sharedSecret: 'base64secret', channelId: 'ch1' },
        { id: 'dev2', name: 'Tablet', sharedSecret: 'anothersecret', channelId: 'ch2' },
      ],
    }
    const encrypted = encryptSensitiveSettings(original)
    const decrypted = decryptSensitiveSettings(encrypted)

    expect(decrypted.themeMode).toBe('dark')
    expect(decrypted.relayApiKey).toBe('my-relay-key')
    expect(decrypted.pairedDevices[0].sharedSecret).toBe('base64secret')
    expect(decrypted.pairedDevices[0].id).toBe('dev1')
    expect(decrypted.pairedDevices[1].sharedSecret).toBe('anothersecret')
  })

  it('decrypts a mixed settings file (v2 legacy + v3 current)', () => {
    const settings = {
      relayApiKey: legacyV2Encrypt('legacy-key'),
      pairedDevices: [{ id: 'd1', sharedSecret: encryptForDisk('current-secret') }],
    }
    const decrypted = decryptSensitiveSettings(settings)
    expect(decrypted.relayApiKey).toBe('legacy-key')
    expect(decrypted.pairedDevices[0].sharedSecret).toBe('current-secret')
  })
})

// ---------------------------------------------------------------------------
// Cross-tier: v3 written in dev, read in dev
// ---------------------------------------------------------------------------

describe('cross-tier scenarios', () => {
  it('v3 values written in dev are readable in dev', () => {
    // Dev build writes
    const settings = { relayApiKey: 'dev-key' }
    const encrypted = encryptSensitiveSettings(settings)
    expect(encrypted.relayApiKey.startsWith('enc:v3:')).toBe(true)

    // Dev build reads
    const decrypted = decryptSensitiveSettings(encrypted)
    expect(decrypted.relayApiKey).toBe('dev-key')
  })

  it('v1 values written in prod are readable in prod', () => {
    mockIsPackaged = true
    mockSafeStorageAvailable = true

    const settings = { relayApiKey: 'prod-key' }
    const encrypted = encryptSensitiveSettings(settings)
    expect(encrypted.relayApiKey.startsWith('enc:v1:')).toBe(true)

    const decrypted = decryptSensitiveSettings(encrypted)
    expect(decrypted.relayApiKey).toBe('prod-key')
  })

  it('v1 values from prod are preserved when read in dev', () => {
    mockIsPackaged = true
    mockSafeStorageAvailable = true
    const encrypted = encryptSensitiveSettings({ relayApiKey: 'prod-only-key' })

    // Switch to dev build
    mockIsPackaged = false
    mockSafeStorageAvailable = false
    const decrypted = decryptSensitiveSettings(encrypted)
    expect(decrypted.relayApiKey).toBe(encrypted.relayApiKey)
  })

  it('v2 written in prod-downgrade scenario upgrades to v1 when packaged', () => {
    const v2 = legacyV2Encrypt('promote-to-keychain')
    mockIsPackaged = true
    mockSafeStorageAvailable = true
    const out = encryptSensitiveSettings({ relayApiKey: v2 })
    expect(out.relayApiKey.startsWith('enc:v1:')).toBe(true)
    expect(decryptFromDisk(out.relayApiKey)).toBe('promote-to-keychain')
  })
})
