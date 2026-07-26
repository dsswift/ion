// Installing the .pkg over a running Ion corrupts the live bundle and fails the
// install. The package must therefore carry a preinstall that quits the app
// first, and build-pkg.sh must actually embed it — passing `--scripts` is the
// only thing that puts the script into the package.
//
// These assertions are red on the unfixed build script, which passed no
// `--scripts` argument and shipped a package with no preinstall at all.
import { describe, it, expect } from 'vitest'
import { readFileSync, statSync, constants } from 'node:fs'
import { accessSync } from 'node:fs'
import { join } from 'node:path'

// __dirname is src/main/__tests__; the scripts dir is at the desktop root.
const scriptsDir = join(__dirname, '..', '..', '..', 'scripts')
const preinstallPath = join(scriptsDir, 'pkg-scripts', 'preinstall')
const buildPkgPath = join(scriptsDir, 'build-pkg.sh')

describe('pkg preinstall script', () => {
  it('exists', () => {
    expect(statSync(preinstallPath).isFile()).toBe(true)
  })

  it('is executable (pkgbuild will not run a non-executable script)', () => {
    expect(() => accessSync(preinstallPath, constants.X_OK)).not.toThrow()
  })

  it('exits 0 on every path so a not-running app never aborts the install', () => {
    const body = readFileSync(preinstallPath, 'utf8')
    // The final statement must be a successful exit.
    const statements = body.trim().split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'))
    expect(statements[statements.length - 1].trim()).toBe('exit 0')
    // The early "not running" return must also be a success exit.
    expect(body).toMatch(/is not running[\s\S]*?exit 0/)
    // No non-zero exit anywhere: that would abort the install.
    expect(body).not.toMatch(/exit [1-9]/)
  })

  it('signals the app with SIGUSR1, the handler the app actually implements', () => {
    const body = readFileSync(preinstallPath, 'utf8')
    expect(body).toContain('kill -USR1')
  })

  it('matches only the main app executable, not helper processes', () => {
    const body = readFileSync(preinstallPath, 'utf8')
    // Anchored on the main binary path so a helper or unrelated process whose
    // path merely contains "Ion" is never signalled as the app.
    expect(body).toContain('.app/Contents/MacOS/${APP_NAME}\\$')
  })

  it('bounds the drain wait under the pkgbuild 10-minute script ceiling', () => {
    const body = readFileSync(preinstallPath, 'utf8')
    const match = /DRAIN_TIMEOUT=(\d+)/.exec(body)
    expect(match).not.toBeNull()
    const timeout = Number(match![1])
    expect(timeout).toBeGreaterThan(0)
    expect(timeout).toBeLessThan(600)
  })
})

describe('build-pkg.sh', () => {
  it('passes --scripts to pkgbuild so the preinstall is embedded', () => {
    const body = readFileSync(buildPkgPath, 'utf8')
    expect(body).toMatch(/--scripts\s+"\$\{SCRIPT_DIR\}\/pkg-scripts"/)
  })

  it('still installs to /Applications with the component payload', () => {
    const body = readFileSync(buildPkgPath, 'utf8')
    expect(body).toContain('--install-location "/Applications"')
    expect(body).toContain('--component "${APP_PATH}"')
  })
})
