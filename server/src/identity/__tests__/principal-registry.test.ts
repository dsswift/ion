import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { registerPrincipal, lookupPrincipal, lookupClaims, _resetPrincipalRegistryForTest } from '../principal-registry'

let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(() => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-principal-registry-'))
  process.env.ION_DATA_DIR = dataDir
  _resetPrincipalRegistryForTest()
})

afterEach(() => {
  _resetPrincipalRegistryForTest()
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe('principal-registry', () => {
  it('returns undefined for a subject that has never authenticated', () => {
    expect(lookupPrincipal('nobody')).toBeUndefined()
  })

  it('resolves a registered principal by subject', () => {
    registerPrincipal({ subject: 'alice', displayName: 'Alice', provider: 'entra', kind: 'operator' })
    expect(lookupPrincipal('alice')).toEqual({ subject: 'alice', displayName: 'Alice', provider: 'entra', kind: 'operator' })
  })

  it('keeps claims in memory only, separate from the persisted principal', () => {
    registerPrincipal({ subject: 'alice', displayName: 'Alice' }, { roles: ['admin'] })
    expect(lookupClaims('alice')).toEqual({ roles: ['admin'] })

    const onDisk = JSON.parse(readFileSync(join(dataDir, 'principals.json'), 'utf-8'))
    expect(onDisk.principals).toEqual([{ subject: 'alice', displayName: 'Alice' }])
  })

  it('persists across a reload of the in-memory map', () => {
    registerPrincipal({ subject: 'alice', displayName: 'Alice' })
    _resetPrincipalRegistryForTest()
    expect(lookupPrincipal('alice')).toEqual({ subject: 'alice', displayName: 'Alice' })
    // Claims never survive the reload -- the file never carried them.
    expect(lookupClaims('alice')).toBeUndefined()
  })

  it('re-registering the same subject overwrites its stored principal', () => {
    registerPrincipal({ subject: 'alice', displayName: 'Alice' })
    registerPrincipal({ subject: 'alice', displayName: 'Alice Renamed' })
    expect(lookupPrincipal('alice')?.displayName).toBe('Alice Renamed')
  })

  it('tolerates a missing principals.json', () => {
    expect(lookupPrincipal('anyone')).toBeUndefined()
  })
})
