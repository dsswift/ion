/**
 * Pins what a managed engine file does to this server's own access to
 * engine.json: reads come from the managed file, and every write is refused
 * before it reaches disk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: { get isPackaged() { return false } },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}))

import { MANAGED_CONFIG_WRITE_REFUSED } from '@ion/shared/types-enterprise'
import { managedEngineConfigSource } from '../../managed-config'
import {
  ManagedEngineConfigError,
  engineConfigFile,
  readEngineConfig,
  setManagedEngineConfigSource,
  updateEngineConfig,
} from '../settings-store'

const USER_CONFIG = JSON.stringify({ limits: { planModeAllowedBashCommands: ['user-cmd'] } })
const MANAGED_CONFIG = JSON.stringify({ limits: { planModeAllowedBashCommands: ['managed-cmd'] } })

describe('managed engine config', () => {
  let dir: string
  let managedPath: string
  const previousDataDir = process.env.ION_DATA_DIR

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ion-managed-engine-'))
    process.env.ION_DATA_DIR = dir
    writeFileSync(engineConfigFile(), USER_CONFIG)
    managedPath = join(dir, 'engine.managed.json')
    writeFileSync(managedPath, MANAGED_CONFIG)
  })

  afterEach(() => {
    setManagedEngineConfigSource(null)
    if (previousDataDir === undefined) delete process.env.ION_DATA_DIR
    else process.env.ION_DATA_DIR = previousDataDir
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads and writes engine.json when no managed file is declared', () => {
    expect(readEngineConfig().limits.planModeAllowedBashCommands).toEqual(['user-cmd'])
    expect(updateEngineConfig((cfg) => { cfg.backend = 'hybrid' })).toBe(true)
    expect(JSON.parse(readFileSync(engineConfigFile(), 'utf-8')).backend).toBe('hybrid')
  })

  it('reads the managed file in place of engine.json', () => {
    setManagedEngineConfigSource({ path: managedPath })
    expect(readEngineConfig().limits.planModeAllowedBashCommands).toEqual(['managed-cmd'])
  })

  it('reads nothing when the managed file did not apply', () => {
    setManagedEngineConfigSource({ path: null })
    expect(readEngineConfig()).toEqual({})
  })

  it('refuses a write, with the engine refusal code, and leaves both files alone', () => {
    setManagedEngineConfigSource({ path: managedPath })
    const mutator = vi.fn()
    let thrown: unknown
    try { updateEngineConfig(mutator) } catch (err) { thrown = err }
    expect(thrown).toBeInstanceOf(ManagedEngineConfigError)
    expect((thrown as ManagedEngineConfigError).code).toBe(MANAGED_CONFIG_WRITE_REFUSED)
    expect(mutator).not.toHaveBeenCalled()
    expect(readFileSync(engineConfigFile(), 'utf-8')).toBe(USER_CONFIG)
    expect(readFileSync(managedPath, 'utf-8')).toBe(MANAGED_CONFIG)
  })
})

describe('managedEngineConfigSource', () => {
  it('is null with no policy or no declared engine file', () => {
    expect(managedEngineConfigSource(null)).toBeNull()
    expect(managedEngineConfigSource({})).toBeNull()
    expect(managedEngineConfigSource({
      managedConfig: { modelsPath: '/managed/models.json', schemaVersion: 1 },
      managedConfigStatus: { schemaVersion: 1, supportedSchemaVersion: 1, models: { projected: true } },
    })).toBeNull()
  })

  it('names the managed file when the engine applied it', () => {
    expect(managedEngineConfigSource({
      managedConfig: { enginePath: '/managed/engine.json', schemaVersion: 1 },
      managedConfigStatus: { schemaVersion: 1, supportedSchemaVersion: 1, engine: { projected: true, checksum: 'sha256:abc' } },
    })).toEqual({ path: '/managed/engine.json' })
  })

  it('stays managed with no file to read when the engine could not apply it', () => {
    expect(managedEngineConfigSource({
      managedConfig: { enginePath: '/managed/engine.json', schemaVersion: 2 },
      managedConfigStatus: { schemaVersion: 2, supportedSchemaVersion: 1, engine: { projected: false, error: 'unsupported' } },
    })).toEqual({ path: null })
  })
})

describe('publishEnterprisePolicy', () => {
  afterEach(() => setManagedEngineConfigSource(null))

  it('turns a published managed engine file into refused writes, and a later policy without one back off', async () => {
    const { publishEnterprisePolicy } = await import('../../enterprise-policy-publish')
    publishEnterprisePolicy({
      managedConfig: { enginePath: '/managed/engine.json', schemaVersion: 2 },
      managedConfigStatus: { schemaVersion: 2, supportedSchemaVersion: 1, engine: { projected: false, error: 'unsupported' } },
    })
    expect(() => updateEngineConfig(() => false)).toThrow(ManagedEngineConfigError)

    publishEnterprisePolicy(null)
    expect(updateEngineConfig(() => false)).toBe(false)
  })
})
