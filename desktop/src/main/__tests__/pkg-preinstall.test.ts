// Installing the .pkg over a running Ion corrupts the live bundle. The package
// must therefore carry a preinstall that refuses before the payload changes.
// `make desktop` coordinates the graceful quit outside Installer; manual and
// MDM package installs remain safe when they start while Ion is live.
import { describe, it, expect } from 'vitest'
import { readFileSync, statSync, constants, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { accessSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

// __dirname is src/main/__tests__; the scripts dir is at the desktop root.
const scriptsDir = join(__dirname, '..', '..', '..', 'scripts')
const preinstallPath = join(scriptsDir, 'pkg-scripts', 'preinstall')
const postinstallPath = join(scriptsDir, 'pkg-scripts', 'postinstall')
const buildPkgPath = join(scriptsDir, 'build-pkg.sh')
const signReleasePkgPath = join(scriptsDir, 'sign-release-pkg.sh')
const workflowPath = join(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'build.yml')

describe('pkg preinstall script', () => {
  it('exists', () => {
    expect(statSync(preinstallPath).isFile()).toBe(true)
  })

  it('is executable (pkgbuild will not run a non-executable script)', () => {
    expect(() => accessSync(preinstallPath, constants.X_OK)).not.toThrow()
  })

  it('allows the install only when Ion is not running', () => {
    const body = readFileSync(preinstallPath, 'utf8')
    expect(body).toMatch(/is not running[\s\S]*?exit 0/)
    expect(body).toMatch(/refusing to replace the live application bundle[\s\S]*?exit 1/)
  })

  it('does not signal or force-kill a running Ion', () => {
    const body = readFileSync(preinstallPath, 'utf8')
    expect(body).not.toContain('kill -USR1')
    expect(body).not.toContain('kill -9')
  })

  it('matches only the main app executable, not helper processes', () => {
    const body = readFileSync(preinstallPath, 'utf8')
    // Anchored on the main binary path so a helper or unrelated process whose
    // path merely contains "Ion" is never signalled as the app.
    expect(body).toContain('.app/Contents/MacOS/${APP_NAME}\\$')
  })

})

describe('pkg postinstall script', () => {
  it('exists, is executable, and launches Ion only for an active console user', () => {
    expect(statSync(postinstallPath).isFile()).toBe(true)
    expect(() => accessSync(postinstallPath, constants.X_OK)).not.toThrow()
    const body = readFileSync(postinstallPath, 'utf8')
    expect(body).toContain('launchctl asuser "$CONSOLE_UID" /usr/bin/env -u TMPDIR /usr/bin/open "$APP_PATH"')
    expect(body).toContain('Do not let the launched app')
    expect(body).toContain('no graphical user is active; leaving Ion closed')
    expect(body).toContain('exit 0')
  })
})

describe('release package trust checks', () => {
  it('refuses to sign a release package without an Installer identity', () => {
    const temporaryPath = mkdtempSync(join(tmpdir(), 'ion-release-signing-'))
    const packagePath = join(temporaryPath, 'Ion.pkg')
    writeFileSync(packagePath, '')

    try {
      const result = spawnSync('bash', [signReleasePkgPath, packagePath], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '' },
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('APPLE_INSTALLER_IDENTITY is required')
    } finally {
      rmSync(temporaryPath, { recursive: true, force: true })
    }
  })

  it('makes signing, notarization, and Gatekeeper acceptance release blockers', () => {
    const workflow = readFileSync(workflowPath, 'utf8')
    const signer = readFileSync(signReleasePkgPath, 'utf8')

    expect(workflow).toContain('ERROR: APPLE_INSTALLER_CERT_BASE64 is required')
    expect(workflow).toContain('ERROR: APPLE_INSTALLER_CERT_PASSWORD is required')
    expect(workflow).toContain('ERROR: imported certificate has no Developer ID Installer identity')
    expect(workflow).toContain('bash scripts/sign-release-pkg.sh "$PKG"')
    expect(workflow).not.toContain('.pkg will be built unsigned')
    expect(workflow).not.toContain('pkg is UNSIGNED')

    expect(signer).toContain('productsign --sign "$APPLE_INSTALLER_IDENTITY"')
    expect(signer).toContain('xcrun notarytool submit "$PKG_PATH"')
    expect(signer).toContain('xcrun stapler validate "$PKG_PATH"')
    expect(signer).toContain('pkgutil --check-signature "$PKG_PATH"')
    expect(signer).toContain('spctl -a -vvv -t install "$PKG_PATH"')
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

  it('verifies the built package by expanding its PackageInfo metadata', () => {
    const checkerPath = join(scriptsDir, 'check-release-version.js')
    const body = readFileSync(checkerPath, 'utf8')
    expect(body).toContain("['--expand', pkgPath, expandedPath]")
    expect(body).toContain("const expandedPath = join(temporaryPath, 'package')")
    expect(body).toContain("const packageInfo = readFileSync(join(expandedPath, 'PackageInfo'), 'utf8')")
    expect(body).toContain('PackageInfo has no pkg-info version')
    expect(body).toContain("mkdtempSync(join(tmpdir(), 'ion-package-'))")
    expect(body).toContain('rmSync(temporaryPath, { recursive: true, force: true })')
    expect(body).not.toContain('--pkg-info-plist')
  })
})
