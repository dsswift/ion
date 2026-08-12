/**
 * Tests for the deep-link capability token.
 *
 * The token is the entire trust boundary of the `ion://` surface: a local
 * process can read the 0600 file and is therefore trusted; a web page cannot and
 * is therefore routed through human confirmation. These tests pin the
 * properties that boundary depends on.
 *
 * The fail-CLOSED case is the important one. If the token cannot be established,
 * `isTrustedToken` must answer false for everything, so an unwritable home
 * degrades to "every deep link asks a human" rather than to "every deep link is
 * trusted".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, mkdirSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// The module resolves its path from homedir() at import time, so home is
// redirected to a temp directory BEFORE the import.
let fakeHome: string

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => fakeHome }
})

vi.mock('../../logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))

describe('deep-link token', () => {
  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'ion-token-test-'))
    mkdirSync(join(fakeHome, '.ion'), { recursive: true })
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true })
  })

  it('mints a token on first use and persists it 0600', async () => {
    const { getDeepLinkToken, DEEPLINK_TOKEN_FILE } = await import('../token')

    const token = getDeepLinkToken()

    expect(token).toHaveLength(64) // 32 random bytes as hex
    const onDisk = readFileSync(DEEPLINK_TOKEN_FILE, 'utf-8').trim()
    expect(onDisk).toBe(token)
    // 0o777 masks off the file-type bits, leaving the permission bits.
    expect(statSync(DEEPLINK_TOKEN_FILE).mode & 0o777).toBe(0o600)
  })

  it('reuses the existing token across calls', async () => {
    const { getDeepLinkToken } = await import('../token')

    expect(getDeepLinkToken()).toBe(getDeepLinkToken())
  })

  it('reads a token written by a previous run', async () => {
    const preExisting = 'a'.repeat(64)
    writeFileSync(join(fakeHome, '.ion', 'deeplink.token'), preExisting + '\n', { mode: 0o600 })

    const { getDeepLinkToken } = await import('../token')

    expect(getDeepLinkToken()).toBe(preExisting)
  })

  it('re-asserts 0600 on a token file that became world-readable', async () => {
    const path = join(fakeHome, '.ion', 'deeplink.token')
    writeFileSync(path, 'b'.repeat(64) + '\n')
    chmodSync(path, 0o644)

    const { getDeepLinkToken } = await import('../token')
    getDeepLinkToken()

    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('replaces a truncated token file rather than trusting it', async () => {
    const path = join(fakeHome, '.ion', 'deeplink.token')
    writeFileSync(path, 'short\n', { mode: 0o600 })

    const { getDeepLinkToken } = await import('../token')

    expect(getDeepLinkToken()).toHaveLength(64)
  })

  it('accepts the correct token and rejects everything else', async () => {
    const { getDeepLinkToken, isTrustedToken } = await import('../token')
    const token = getDeepLinkToken()

    expect(isTrustedToken(token)).toBe(true)
    expect(isTrustedToken('c'.repeat(64))).toBe(false)   // right length, wrong value
    expect(isTrustedToken(token.slice(0, 63))).toBe(false) // truncated
    expect(isTrustedToken(token + 'd')).toBe(false)      // extended
    expect(isTrustedToken('')).toBe(false)
    expect(isTrustedToken(undefined)).toBe(false)
    expect(isTrustedToken(null)).toBe(false)
  })

  it('fails CLOSED when the token cannot be established', async () => {
    // An unwritable ~/.ion: minting throws, so nothing can be trusted.
    const ionDir = join(fakeHome, '.ion')
    chmodSync(ionDir, 0o500)
    try {
      const { getDeepLinkToken, isTrustedToken } = await import('../token')

      expect(getDeepLinkToken()).toBe('')
      // Notably NOT trusted-by-default, and an empty supplied token does not
      // match the empty actual token.
      expect(isTrustedToken('')).toBe(false)
      expect(isTrustedToken('e'.repeat(64))).toBe(false)
    } finally {
      chmodSync(ionDir, 0o700)
    }
  })
})
