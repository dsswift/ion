/**
 * Secret Store Tests
 *
 * Tests for the two-tier encryption system in secretStore.ts.
 * Tier 1 (safeStorage) is mocked since it requires Electron's main process.
 * Tier 2 (machine-derived AES-GCM) is tested directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock Electron's app and safeStorage before importing the module
// ---------------------------------------------------------------------------

let mockIsPackaged = false
let mockSafeStorageAvailable = false
const mockEncryptedValues = new Map<string, Buffer>()

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged
    },
  },
  safeStorage: {
    isEncryptionAvailable: () => mockSafeStorageAvailable,
    encryptString: (plaintext: string) => {
      // Simulate safeStorage by storing the value and returning a deterministic buffer
      const buf = Buffer.from(`safe:${plaintext}`)
      mockEncryptedValues.set(plaintext, buf)
      return buf
    },
    decryptString: (buf: Buffer) => {
      const str = buf.toString()
      if (!str.startsWith('safe:')) throw new Error('invalid safeStorage ciphertext')
      return str.slice(5)
    },
  },
}))

import {
  isSafeStorageReady,
  encryptForDisk,
  decryptFromDisk,
  encryptSensitiveSettings,
  decryptSensitiveSettings,
} from '../utils/secretStore'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockIsPackaged = false
  mockSafeStorageAvailable = false
  mockEncryptedValues.clear()
})

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
// Tier 2: machine-derived encryption (dev builds)
// ---------------------------------------------------------------------------

describe('machine-derived encryption (tier 2)', () => {
  it('encrypts with enc:v2: prefix in dev builds', () => {
    const encrypted = encryptForDisk('my-secret-key')
    expect(encrypted.startsWith('enc:v2:')).toBe(true)
    expect(encrypted).not.toContain('my-secret-key')
  })

  it('round-trips through encrypt → decrypt', () => {
    const plaintext = 'relay-api-key-12345'
    const encrypted = encryptForDisk(plaintext)
    const decrypted = decryptFromDisk(encrypted)
    expect(decrypted).toBe(plaintext)
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

  it('returns empty string for corrupted v2 ciphertext', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = decryptFromDisk('enc:v2:dGhpcyBpcyBub3QgdmFsaWQ=')
    expect(result).toBe('')
    spy.mockRestore()
  })

  it('returns empty string for truncated v2 ciphertext', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = decryptFromDisk('enc:v2:AAAA')
    expect(result).toBe('')
    spy.mockRestore()
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

  it('clears v1 values when safeStorage becomes unavailable', () => {
    const encrypted = encryptForDisk('ephemeral-secret')
    expect(encrypted.startsWith('enc:v1:')).toBe(true)

    // Simulate switching to dev build
    mockIsPackaged = false
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = decryptFromDisk(encrypted)
    expect(result).toBe('')
    spy.mockRestore()
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
    expect(encrypted.relayApiKey.startsWith('enc:v2:')).toBe(true)
    // sharedSecret should now be encrypted
    expect(encrypted.pairedDevices[0].sharedSecret).not.toBe('old-plaintext-secret')
    expect(encrypted.pairedDevices[0].sharedSecret.startsWith('enc:v2:')).toBe(true)
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
})

// ---------------------------------------------------------------------------
// Cross-tier: v2 written in dev, read in dev
// ---------------------------------------------------------------------------

describe('cross-tier scenarios', () => {
  it('v2 values written in dev are readable in dev', () => {
    // Dev build writes
    const settings = { relayApiKey: 'dev-key' }
    const encrypted = encryptSensitiveSettings(settings)
    expect(encrypted.relayApiKey.startsWith('enc:v2:')).toBe(true)

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

  it('v1 values from prod are cleared when read in dev (graceful degradation)', () => {
    mockIsPackaged = true
    mockSafeStorageAvailable = true
    const encrypted = encryptSensitiveSettings({ relayApiKey: 'prod-only-key' })

    // Switch to dev build
    mockIsPackaged = false
    mockSafeStorageAvailable = false
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const decrypted = decryptSensitiveSettings(encrypted)
    expect(decrypted.relayApiKey).toBe('')
    spy.mockRestore()
  })
})
