// Installing the .pkg over a running Ion corrupts the live bundle. The package
// must therefore carry scripts that decide what happens to a running Ion and
// that swap a complete bundle into place. This file pins how the package is
// assembled; pkg-install-scripts.test.ts runs the scripts.
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
const commonPath = join(scriptsDir, 'pkg-scripts', 'ion-pkg-common.sh')
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

  it('refuses a running Ion unless device policy selects replace', () => {
    const body = readFileSync(commonPath, 'utf8')
    expect(body).toContain('POLICY_PLIST="${ION_PKG_POLICY_PLIST:-/Library/Managed Preferences/com.ion.engine.plist}"')
    expect(body).toContain('POLICY_KEY=":customFields:ion-desktop:installer"')
    expect(body).toMatch(/"\) printf 'refuse' ;;/)
    expect(body).toMatch(/refusing to replace the live application bundle[\s\S]*?return 1/)
  })

  it('keeps the whole stop sequence inside the package script timeout', () => {
    const body = readFileSync(commonPath, 'utf8')
    const number = (name: string): number => Number(new RegExp(`${name}="?(?:\\$\\{[A-Z_]+:-)?(\\d+)`).exec(body)?.[1])
    const worstCase = number('MAX_DRAIN_TIMEOUT_SECONDS') + number('FORCED_QUIT_WAIT_SECONDS') + number('KILL_WAIT_SECONDS')
    // pkgbuild gives each top-level script 600 seconds.
    expect(worstCase).toBeLessThan(600)
    expect(number('DEFAULT_DRAIN_TIMEOUT_SECONDS')).toBeLessThanOrEqual(number('MAX_DRAIN_TIMEOUT_SECONDS'))
  })

  it('matches only the main executable of the bundle being replaced', () => {
    const body = readFileSync(commonPath, 'utf8')
    // Anchored on the installed bundle's main binary, so a helper, or an Ion
    // running from another directory, is never signalled as the app.
    expect(body).toContain('pgrep -f "$(regex_escape "${APP_PATH}/Contents/MacOS/${APP_NAME}")( |\\$)"')
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
  it('passes --scripts to pkgbuild so the install scripts are embedded', () => {
    const body = readFileSync(buildPkgPath, 'utf8')
    expect(body).toMatch(/--scripts\s+"\$\{SCRIPT_DIR\}\/pkg-scripts"/)
  })

  it('installs the payload into the staging directory postinstall swaps from', () => {
    const body = readFileSync(buildPkgPath, 'utf8')
    const staging = /^STAGING_DIR="(.+)"$/m.exec(body)?.[1]
    expect(staging).toBeTruthy()
    expect(readFileSync(commonPath, 'utf8')).toContain(`STAGING_DIR="\${ION_PKG_STAGING_DIR:-${staging}}"`)
    expect(body).toContain('--install-location "${STAGING_DIR}"')
    expect(body).not.toContain('--install-location "/Applications"')
  })

  it('pins the bundle to the package location and installs any version', () => {
    const body = readFileSync(buildPkgPath, 'utf8')
    expect(body).toContain('--component-plist "${COMPONENT_PLIST}"')
    expect(body).toContain("Add :0:BundleIsRelocatable bool false")
    expect(body).toContain("Set :0:BundleIsVersionChecked false")
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
