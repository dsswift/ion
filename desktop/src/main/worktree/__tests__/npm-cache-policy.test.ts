import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const REPOSITORY_ROOT = resolve(__dirname, '../../../../..')
const DESKTOP_ROOT = resolve(REPOSITORY_ROOT, 'desktop')

// npm ships as a .cmd shim on Windows; execFileSync bypasses the shell that
// would otherwise resolve the bare "npm" through PATHEXT, so ENOENT is the
// result of naming the wrong file, not a missing install. Naming npm.cmd
// directly isn't enough on its own: Windows refuses to CreateProcess a .bat
// or .cmd file at all without shell: true (Node reports that refusal as
// EINVAL), regardless of which name was passed.
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function npmConfig(cwd: string, key: string): string {
  return execFileSync(NPM_BIN, ['config', 'get', key], {
    cwd,
    encoding: 'utf-8',
    shell: process.platform === 'win32',
  }).trim()
}

describe('npm cache policy', () => {
  it('prefers cached archives from root and desktop installs', () => {
    expect(existsSync(resolve(REPOSITORY_ROOT, '.npmrc'))).toBe(true)
    expect(npmConfig(REPOSITORY_ROOT, 'prefer-offline')).toBe('true')
    expect(npmConfig(DESKTOP_ROOT, 'prefer-offline')).toBe('true')
  })

  it('keeps cache misses available to normal registry installs', () => {
    expect(npmConfig(REPOSITORY_ROOT, 'offline')).toBe('false')
    expect(npmConfig(DESKTOP_ROOT, 'offline')).toBe('false')
  })
})
