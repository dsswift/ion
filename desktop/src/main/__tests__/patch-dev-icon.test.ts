/**
 * patchDevIcon regression tests (postinstall.js).
 *
 * Background: the desktop `postinstall` chain is `&&`-joined, so anything it
 * runs that throws aborts the whole `npm install`.
 *
 * patchDevIcon swaps the dev Dock icon by copying resources/icon.icns into the
 * extracted Electron.app bundle. The original bash version assumed that bundle
 * (node_modules/electron/dist/Electron.app) always existed by the time it ran —
 * i.e. that electron's own install.js had already extracted the prebuilt
 * binary.
 *
 * That assumption is not guaranteed. An interrupted install, a transient
 * download failure, or a prior `npm ci --ignore-scripts` that left node_modules
 * in place all leave an electron package whose dist/ was never populated. In
 * that state the original copied to a missing path, which failed and — because
 * of the `&&` chain — aborted the install. setup.command then mis-reported the
 * failure as an Xcode/toolchain problem ("run xcode-select --install").
 *
 * The contract these tests pin, unchanged by the bash-to-Node port:
 *   1. A missing electron dist/ must NOT throw (the regression), and must say
 *      so on stderr so the skip is observable.
 *   2. A missing source icon is a no-op.
 *   3. A present bundle actually gets the icon.
 *
 * They exercise the real function against a synthetic desktop directory, so
 * they have no network dependency and never download electron.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'

import { patchDevIcon } from '../../../scripts/postinstall.js'

// The function is darwin-only by design: the Electron.app bundle icon is a Dock
// cosmetic with no Windows or Linux counterpart. On another host every branch
// below is unreachable, so the suite asserts only the platform guard there.
const isDarwin = process.platform === 'darwin'

let workdir: string
let logs: string[]

beforeEach(() => {
  workdir = fs.mkdtempSync(join(os.tmpdir(), 'patch-dev-icon-'))
  logs = []
  vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')) })
  vi.spyOn(console, 'error').mockImplementation((...args) => { logs.push(args.join(' ')) })
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(workdir, { recursive: true, force: true })
})

function writeIcon(): void {
  fs.mkdirSync(join(workdir, 'resources'), { recursive: true })
  fs.writeFileSync(join(workdir, 'resources', 'icon.icns'), 'fake-icon-bytes')
}

describe('patchDevIcon', () => {
  it('is a no-op off darwin', () => {
    if (isDarwin) return
    writeIcon()
    expect(() => patchDevIcon(workdir)).not.toThrow()
    expect(logs).toEqual([])
  })

  it('does not throw when the source icon is absent', () => {
    if (!isDarwin) return
    expect(() => patchDevIcon(workdir)).not.toThrow()
    expect(logs.join('\n')).toMatch(/nothing to patch/i)
  })

  it('does NOT throw when electron dist/ is missing (regression)', () => {
    if (!isDarwin) return

    // Reproduce the failure state: a source icon exists, but the electron
    // package has no dist/ (extracted bundle) and no install.js to self-heal
    // with. This is the exact shape that previously aborted `npm install`.
    writeIcon()
    fs.mkdirSync(join(workdir, 'node_modules', 'electron'), { recursive: true })
    // Deliberately do NOT create dist/ or install.js.

    expect(() => patchDevIcon(workdir)).not.toThrow()
    expect(logs.join('\n')).toMatch(/skipping icon patch/i)
  })

  it('patches the icon when the electron bundle is present', () => {
    if (!isDarwin) return

    const bundleResources = join(
      workdir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Resources',
    )
    fs.mkdirSync(bundleResources, { recursive: true })
    writeIcon()

    patchDevIcon(workdir)

    const copied = join(bundleResources, 'electron.icns')
    expect(fs.existsSync(copied)).toBe(true)
    expect(fs.readFileSync(copied, 'utf8')).toBe('fake-icon-bytes')
  })
})
