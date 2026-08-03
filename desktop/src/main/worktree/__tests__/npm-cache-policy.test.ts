import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

const REPOSITORY_ROOT = resolve(__dirname, '../../../../..')
const DESKTOP_ROOT = resolve(REPOSITORY_ROOT, 'desktop')

function npmConfig(cwd: string, key: string): string {
  return execFileSync('npm', ['config', 'get', key], {
    cwd,
    encoding: 'utf-8',
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
