/**
 * patch-dev-icon.sh regression tests
 *
 * Background: the desktop `postinstall` chain is `&&`-joined:
 *
 *   electron-builder install-app-deps && bash scripts/patch-dev-icon.sh && ...
 *
 * `patch-dev-icon.sh` swaps the dev dock icon by copying resources/icon.icns
 * into the extracted Electron.app bundle. The original version assumed that
 * bundle (node_modules/electron/dist/Electron.app) always existed by the time
 * it ran — i.e. that electron's own postinstall (install.js) had already
 * extracted the prebuilt binary.
 *
 * That assumption is not guaranteed. An interrupted install, a transient
 * download failure, or a prior `npm ci --ignore-scripts` that left node_modules
 * in place all leave an electron package whose dist/ was never populated. In
 * that state the old script did `cp resources/icon.icns <missing path>`, which
 * failed with "cp: ... No such file or directory" and — because of the `&&`
 * chain — aborted the entire `npm install`. setup.command then mis-reported the
 * failure as an Xcode/toolchain problem ("run xcode-select --install").
 *
 * The fix makes the script self-heal: if dist/ is missing it runs electron's
 * install.js to extract the binary, and if that is impossible it SKIPS the
 * cosmetic icon patch with exit 0 rather than crashing the install.
 *
 * These tests pin the contract that matters for the install chain:
 *   1. Missing electron dist/ must NOT cause a non-zero exit (the regression).
 *   2. A missing source icon is a no-op (exit 0), unchanged behavior.
 *
 * They exercise the real script with a synthetic working directory so they have
 * no network dependency and never download electron.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import { join } from 'path'

const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'patch-dev-icon.sh')

// Only meaningful on macOS — the script is a no-op (exit 0) elsewhere because of
// its `[[ "$(uname)" == "Darwin" ]] || exit 0` guard. On Linux CI the runDarwin
// branches below are skipped; the no-op-on-non-darwin expectation still holds.
const isDarwin = process.platform === 'darwin'

let workdir: string

/**
 * Run patch-dev-icon.sh with `cwd` as the working directory (the script uses
 * paths relative to cwd, mirroring how npm invokes it from desktop/). Returns
 * the exit status; throws only on spawn failure, not on non-zero exit, so tests
 * can assert on the status explicitly.
 */
function runScript(cwd: string): { status: number; output: string } {
  // Run via `bash -c 'bash SCRIPT 2>&1'` so stderr is merged into stdout. That
  // way the script's diagnostics are observable on both the success path
  // (execFileSync returns stdout) and the failure path (thrown err.stdout),
  // without depending on which stream the script chose.
  try {
    const out = execFileSync('bash', ['-c', `bash "${SCRIPT}" 2>&1`], {
      cwd,
      encoding: 'utf8',
    })
    return { status: 0, output: out ?? '' }
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: Buffer | string }
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      output: e.stdout ? e.stdout.toString() : '',
    }
  }
}

beforeEach(() => {
  workdir = fs.mkdtempSync(join(os.tmpdir(), 'patch-dev-icon-'))
})

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true })
})

describe('patch-dev-icon.sh', () => {
  it('exits 0 when the source icon is absent (no-op)', () => {
    // No resources/icon.icns in workdir → script should bail early, exit 0.
    const { status } = runScript(workdir)
    expect(status).toBe(0)
  })

  it('does NOT crash the install when electron dist/ is missing (regression)', () => {
    if (!isDarwin) {
      // Non-darwin: script exits 0 before touching electron at all.
      const { status } = runScript(workdir)
      expect(status).toBe(0)
      return
    }

    // Reproduce the failure state: a source icon exists, but the electron
    // package has no dist/ (extracted bundle) and no install.js to self-heal
    // with. This is the exact shape that previously aborted `npm install`.
    fs.mkdirSync(join(workdir, 'resources'), { recursive: true })
    fs.writeFileSync(join(workdir, 'resources', 'icon.icns'), 'fake-icon-bytes')
    fs.mkdirSync(join(workdir, 'node_modules', 'electron'), { recursive: true })
    // Deliberately do NOT create dist/ or install.js.

    const { status, output } = runScript(workdir)

    // The contract: a missing electron bundle must degrade to a skipped
    // cosmetic patch (exit 0), never a hard install failure (non-zero exit).
    expect(status).toBe(0)
    // And it should say so on stderr so the skip is observable in logs.
    expect(output).toMatch(/skipping icon patch/i)
  })

  it('patches the icon when the electron bundle is present', () => {
    if (!isDarwin) return

    // Build a minimal fake electron bundle with the Resources dir present.
    const resources = join(
      workdir,
      'node_modules',
      'electron',
      'dist',
      'Electron.app',
      'Contents',
      'Resources',
    )
    fs.mkdirSync(resources, { recursive: true })
    fs.mkdirSync(join(workdir, 'resources'), { recursive: true })
    fs.writeFileSync(join(workdir, 'resources', 'icon.icns'), 'fake-icon-bytes')

    const { status } = runScript(workdir)
    expect(status).toBe(0)

    // The icon must have been copied into the bundle.
    const copied = join(resources, 'electron.icns')
    expect(fs.existsSync(copied)).toBe(true)
    expect(fs.readFileSync(copied, 'utf8')).toBe('fake-icon-bytes')
  })
})
