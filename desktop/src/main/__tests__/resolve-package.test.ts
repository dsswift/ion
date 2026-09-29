/**
 * resolve-package — finding a dependency under either install layout.
 *
 * The regression: the repo became an npm workspace, npm hoisted electron to
 * the workspace root, and every `path.join(desktopDir, 'node_modules', …)`
 * stopped resolving. `make desktop` refused to build ("Could not verify
 * installed Electron dependencies") and each build-time patch turned into a
 * skip nobody read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { packageDir, packagePath, packageVersion } from '../../../scripts/resolve-package.js'

const DESKTOP_DIR = join(__dirname, '..', '..', '..')

let root: string

function installPackage(at: string, name: string, version: string): void {
  const dir = join(at, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-resolve-pkg-'))
  mkdirSync(join(root, 'desktop'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('packageDir', () => {
  it('finds a package hoisted to the workspace root', () => {
    installPackage(root, 'electron', '35.7.5')

    expect(packageDir('electron', join(root, 'desktop'))).toBe(join(root, 'node_modules', 'electron'))
  })

  it('prefers the nearest node_modules when both layouts are present', () => {
    installPackage(root, 'electron', '35.7.5')
    installPackage(join(root, 'desktop'), 'electron', '36.0.0')

    expect(packageDir('electron', join(root, 'desktop')))
      .toBe(join(root, 'desktop', 'node_modules', 'electron'))
  })

  it('returns undefined when the package is installed nowhere above the start', () => {
    expect(packageDir('not-a-real-package', join(root, 'desktop'))).toBeUndefined()
  })
})

describe('packageVersion', () => {
  it('reads the version of a hoisted package', () => {
    installPackage(root, 'electron-builder', '26.15.3')

    expect(packageVersion('electron-builder', join(root, 'desktop'))).toBe('26.15.3')
  })

  it('returns an empty string for an absent package, never throwing', () => {
    expect(packageVersion('not-a-real-package', join(root, 'desktop'))).toBe('')
  })
})

describe('the real install', () => {
  it('resolves electron and electron-builder from the desktop package', () => {
    expect(packageVersion('electron')).toMatch(/^\d+\./)
    expect(packageVersion('electron-builder')).toMatch(/^\d+\./)
    expect(packagePath('electron', 'package.json')).toContain('electron')
  })
})

describe('the shell entry points', () => {
  // These two run outside any test harness, so the only thing that keeps them
  // honest is that they ask the resolver instead of joining their own prefix.
  it.each(['commands/setup.command', 'commands/stop.command'])('%s resolves electron instead of assuming a path', (file) => {
    const contents = readFileSync(join(DESKTOP_DIR, file), 'utf-8')

    expect(contents).not.toContain('node_modules/electron')
    expect(contents).toContain('resolve-package')
  })
})
