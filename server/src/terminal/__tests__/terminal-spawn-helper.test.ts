import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describeSpawnHelperIn, ensureSpawnHelperExecutableIn, spawnHelperHint } from '../terminal-spawn-helper'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ion-spawn-helper-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('describeSpawnHelperIn', () => {
  it('reports a missing helper', () => {
    const status = describeSpawnHelperIn(dir, 'darwin', 'x64')
    expect(status).toEqual({ path: join(dir, 'prebuilds', 'darwin-x64', 'spawn-helper'), exists: false, executable: false })
    expect(spawnHelperHint(status)).toMatch(/missing/)
  })

  it('reports a helper npm extracted without its execute bit, with the chmod to run', () => {
    const helperDir = join(dir, 'prebuilds', 'linux-x64')
    mkdirSync(helperDir, { recursive: true })
    const helper = join(helperDir, 'spawn-helper')
    writeFileSync(helper, '#!/bin/sh\n')
    chmodSync(helper, 0o644)
    const status = describeSpawnHelperIn(dir, 'linux', 'x64')
    expect(status).toMatchObject({ exists: true, executable: false })
    expect(spawnHelperHint(status)).toBe(`node-pty spawn-helper at ${helper} is not executable; run: chmod +x ${helper}`)
  })

  it('is silent for an executable helper, and has nothing to say on windows or without node-pty', () => {
    const helperDir = join(dir, 'prebuilds', 'darwin-arm64')
    mkdirSync(helperDir, { recursive: true })
    const helper = join(helperDir, 'spawn-helper')
    writeFileSync(helper, '#!/bin/sh\n')
    chmodSync(helper, 0o755)
    expect(spawnHelperHint(describeSpawnHelperIn(dir, 'darwin', 'arm64'))).toBeNull()
    expect(describeSpawnHelperIn(dir, 'win32', 'x64')).toEqual({ path: null, exists: false, executable: false })
    expect(spawnHelperHint(describeSpawnHelperIn(null))).toMatch(/not installed/)
  })
})

describe('ensureSpawnHelperExecutableIn', () => {
  it('restores the execute bit npm dropped and reports the repair', () => {
    const helperDir = join(dir, 'prebuilds', 'darwin-arm64')
    mkdirSync(helperDir, { recursive: true })
    const helper = join(helperDir, 'spawn-helper')
    writeFileSync(helper, '#!/bin/sh\n')
    chmodSync(helper, 0o644)
    const repair = ensureSpawnHelperExecutableIn(dir, 'darwin', 'arm64')
    expect(repair).toEqual({ status: { path: helper, exists: true, executable: true }, repaired: true, error: null })
    expect(describeSpawnHelperIn(dir, 'darwin', 'arm64').executable).toBe(true)
  })

  it('is a no-op for an executable helper and says nothing when there is nothing to repair', () => {
    const helperDir = join(dir, 'prebuilds', 'linux-x64')
    mkdirSync(helperDir, { recursive: true })
    const helper = join(helperDir, 'spawn-helper')
    writeFileSync(helper, '#!/bin/sh\n')
    chmodSync(helper, 0o755)
    expect(ensureSpawnHelperExecutableIn(dir, 'linux', 'x64')).toEqual({ status: { path: helper, exists: true, executable: true }, repaired: false, error: null })
    expect(ensureSpawnHelperExecutableIn(dir, 'linux', 'arm64')).toMatchObject({ repaired: false, error: null, status: { exists: false } })
    expect(ensureSpawnHelperExecutableIn(null)).toMatchObject({ repaired: false, error: null, status: { path: null } })
  })

  it('returns the chmod failure when the bit cannot be set', () => {
    // A parent directory without write permission stands in for the
    // root-owned /Applications bundle: chmod on a file inside it is refused
    // for a non-root user.
    if (process.getuid?.() === 0 || process.platform === 'win32') return
    const helperDir = join(dir, 'prebuilds', 'darwin-x64')
    mkdirSync(helperDir, { recursive: true })
    const helper = join(helperDir, 'spawn-helper')
    writeFileSync(helper, '#!/bin/sh\n')
    chmodSync(helper, 0o644)
    chownSafe(helper)
    const repair = ensureSpawnHelperExecutableIn(dir, 'darwin', 'x64')
    expect(repair.repaired).toBe(false)
    expect(repair.error).toMatch(/EPERM|not permitted/)
    expect(repair.status.executable).toBe(false)
  })
})

/**
 * Make `path` unchmod-able by this user: chmod requires OWNERSHIP of the file,
 * not write access, so the only way to stage a refusal without root is to hand
 * the file to another owner -- which a non-root user cannot do either. Instead
 * the helper is replaced by a symlink to a root-owned, non-executable system file;
 * chmodSync follows the link and is refused on the target.
 */
function chownSafe(path: string): void {
  rmSync(path)
  symlinkSync('/etc/hosts', path)
}

