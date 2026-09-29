/**
 * One encryption tier for every writer, and a one-time migration of the
 * legacy Keychain tier.
 *
 * The Studio server owns settings.json, credentials.json and
 * browser-sessions.json but is a plain Node process: a value the packaged
 * desktop had encrypted with Electron's safeStorage (enc:v1) was unreadable
 * to it, so both paired iOS devices went "unusable" and the server warned on
 * every read. The keyfile tier is the one both processes share.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _setElectronForTest,
  _setKeyfilePathForTest,
  decryptFromDisk,
  encryptForDisk,
  migrateLegacySafeStorageSecrets,
  reencryptLegacySafeStorageValues,
} from '../secretStore'

/** A safeStorage stand-in: reversible, so a "Keychain" value can be minted and read back in the test. */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`kc:${s}`, 'utf-8'),
  decryptString: (b: Buffer) => b.toString('utf-8').replace(/^kc:/, ''),
}
const v1 = (plain: string): string => 'enc:v1:' + fakeSafeStorage.encryptString(plain).toString('base64')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-secrets-'))
  _setKeyfilePathForTest(join(dir, 'desktop-secrets.key'))
})
afterEach(() => {
  _setElectronForTest(undefined)
  _setKeyfilePathForTest(undefined)
  rmSync(dir, { recursive: true, force: true })
})

describe('encryptForDisk', () => {
  it('writes the keyfile tier even inside a packaged Electron with safeStorage available', () => {
    _setElectronForTest({ app: { isPackaged: true }, safeStorage: fakeSafeStorage } as never)
    const out = encryptForDisk('shared-secret')
    expect(out.startsWith('enc:v3:')).toBe(true)
    expect(decryptFromDisk(out)).toBe('shared-secret')
  })

  it('round-trips through a process with no Electron at all', () => {
    _setElectronForTest(null)
    expect(decryptFromDisk(encryptForDisk('abc'))).toBe('abc')
  })
})

describe('migrateLegacySafeStorageSecrets', () => {
  it('rewrites every enc:v1 leaf under the keyfile tier and leaves other values alone', () => {
    _setElectronForTest({ app: { isPackaged: true }, safeStorage: fakeSafeStorage } as never)
    const settings = join(dir, 'settings.json')
    writeFileSync(settings, JSON.stringify({
      relayApiKey: v1('relay-key'),
      pairedDevices: [
        { name: 'phone', sharedSecret: v1('s1'), relayOidcSubject: v1('sub1') },
        { name: 'pad', sharedSecret: 'enc:v3:already', relayOidcSubject: null },
      ],
      theme: 'dark',
    }))
    writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ version: 1, clients: [{ id: 'c', secretRef: v1('client-secret') }] }))

    const report = migrateLegacySafeStorageSecrets(dir)
    expect(report).toMatchObject({ rewritten: 4, unreadable: 0, safeStorageReady: true })
    expect(report.files).toEqual([settings, join(dir, 'credentials.json')])

    const next = JSON.parse(readFileSync(settings, 'utf-8'))
    expect(decryptFromDisk(next.relayApiKey)).toBe('relay-key')
    expect(next.relayApiKey.startsWith('enc:v3:')).toBe(true)
    expect(decryptFromDisk(next.pairedDevices[0].sharedSecret)).toBe('s1')
    expect(decryptFromDisk(next.pairedDevices[0].relayOidcSubject)).toBe('sub1')
    expect(next.pairedDevices[1]).toEqual({ name: 'pad', sharedSecret: 'enc:v3:already', relayOidcSubject: null })
    expect(next.theme).toBe('dark')
    expect(statSync(settings).mode & 0o777).toBe(0o600)
    const creds = JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf-8'))
    expect(decryptFromDisk(creds.clients[0].secretRef)).toBe('client-secret')
  })

  it('counts but never rewrites values it cannot decrypt (no Electron), and does not touch the file', () => {
    _setElectronForTest(null)
    const settings = join(dir, 'settings.json')
    const original = JSON.stringify({ pairedDevices: [{ sharedSecret: v1('s1') }] })
    writeFileSync(settings, original)
    const before = statSync(settings).mtimeMs
    const report = migrateLegacySafeStorageSecrets(dir)
    expect(report).toMatchObject({ rewritten: 0, unreadable: 1, safeStorageReady: false })
    expect(readFileSync(settings, 'utf-8')).toBe(original)
    expect(statSync(settings).mtimeMs).toBe(before)
  })

  it('preserves a ciphertext the Keychain refuses rather than blanking it', () => {
    _setElectronForTest({
      app: { isPackaged: true },
      safeStorage: { ...fakeSafeStorage, decryptString: () => { throw new Error('grant bound to another signature') } },
    } as never)
    const counters = { rewritten: 0, unreadable: 0 }
    const out = reencryptLegacySafeStorageValues({ a: v1('x'), b: 'plain' }, counters) as { a: string; b: string }
    expect(out.a).toBe(v1('x'))
    expect(out.b).toBe('plain')
    expect(counters).toEqual({ rewritten: 0, unreadable: 1 })
  })
})
