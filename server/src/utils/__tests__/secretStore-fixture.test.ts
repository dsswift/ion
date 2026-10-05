/**
 * The desktop's sealed-secret format is read and written by the Go fleet too
 * (`engine/internal/fleet/secrets.go`), so both use one pairing store. This
 * fixture is what `encryptForDisk` wrote under a fixed key; the Go test opens
 * the same file. If the format changes here, this fails until the fixture
 * and the Go side move with it.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _setKeyfilePathForTest, decryptFromDisk, encryptForDisk } from '../secretStore'

const fixture = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'packages', 'shared', 'src', '__fixtures__', 'desktop-secret-v3.json'), 'utf-8')) as { keyHex: string; plaintext: string; sealed: string }

afterEach(() => _setKeyfilePathForTest(undefined))

describe('the sealed-secret fixture shared with the Go fleet', () => {
  it('opens under its key, and a new value has the same layout', () => {
    const keyfile = join(mkdtempSync(join(tmpdir(), 'ion-secret-fixture-')), 'desktop-secrets.key')
    writeFileSync(keyfile, fixture.keyHex)
    _setKeyfilePathForTest(keyfile)
    expect(decryptFromDisk(fixture.sealed)).toBe(fixture.plaintext)
    const again = encryptForDisk(fixture.plaintext)
    expect(again.startsWith('enc:v3:')).toBe(true)
    // nonce (12) + tag (16) + one ciphertext byte per plaintext byte.
    expect(Buffer.from(again.slice('enc:v3:'.length), 'base64')).toHaveLength(12 + 16 + Buffer.byteLength(fixture.plaintext))
  })
})
