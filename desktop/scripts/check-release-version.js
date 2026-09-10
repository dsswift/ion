#!/usr/bin/env node
const { existsSync, readFileSync, mkdtempSync, rmSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { basename, join } = require('node:path')

function fail(message) {
  process.stderr.write(`release-version check failed: ${message}\n`)
  process.exit(1)
}

function packageVersion(pkgPath) {
  const temporaryPath = mkdtempSync(join(tmpdir(), 'ion-package-'))
  const expandedPath = join(temporaryPath, 'package')
  try {
    execFileSync('pkgutil', ['--expand', pkgPath, expandedPath], { stdio: 'pipe' })
    const packageInfo = readFileSync(join(expandedPath, 'PackageInfo'), 'utf8')
    const match = /<pkg-info\b(?=[^>]*\sversion="([^"]+)")/.exec(packageInfo)
    if (!match) throw new Error('PackageInfo has no pkg-info version')
    return match[1]
  } finally {
    rmSync(temporaryPath, { recursive: true, force: true })
  }
}

/** Parses the `version:` line out of an electron-updater latest.yml feed file. */
function latestYmlVersion(ymlPath) {
  const contents = readFileSync(ymlPath, 'utf8')
  const match = /^version:\s*(.+)$/m.exec(contents)
  if (!match) throw new Error(`${ymlPath} has no version: line`)
  return match[1].trim()
}

const expected = process.argv[2]
const appPath = process.argv[3]
const packagePath = process.argv[4]
if (!expected || !appPath || !packagePath) {
  fail('usage: check-release-version.js <version> <Ion.app|ion.exe> <Ion.pkg|latest.yml>')
}

const packageVersionFromManifest = JSON.parse(readFileSync('package.json', 'utf8')).version
if (packageVersionFromManifest !== expected) fail(`package.json=${packageVersionFromManifest}, expected=${expected}`)

if (packagePath.endsWith('.yml')) {
  // Windows: appPath is the produced installer .exe. There is no bundle plist
  // to read, so the two independently-produced version strings to cross-check
  // are electron-builder's artifactName (which stamps the version into the
  // filename) and the electron-updater latest.yml feed it writes beside it.
  if (!existsSync(appPath)) fail(`installer not found at ${appPath}`)
  const installerName = basename(appPath)
  if (!installerName.includes(`-${expected}-`)) {
    fail(`installer filename ${installerName} does not carry version ${expected}`)
  }
  const ymlVersion = latestYmlVersion(packagePath)
  if (ymlVersion !== expected) fail(`latest.yml version=${ymlVersion}, expected=${expected}`)
  process.stdout.write(`release-version check: OK (${expected})\n`)
  process.exit(0)
}

const plist = `${appPath}/Contents/Info.plist`
const shortVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], { encoding: 'utf8' }).trim()
const bundleVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', plist], { encoding: 'utf8' }).trim()
if (shortVersion !== expected) fail(`CFBundleShortVersionString=${shortVersion}, expected=${expected}`)
if (bundleVersion !== expected) fail(`CFBundleVersion=${bundleVersion}, expected=${expected}`)

const pkgVersion = packageVersion(packagePath)
if (pkgVersion !== expected) fail(`PKG version=${pkgVersion}, expected=${expected}`)

process.stdout.write(`release-version check: OK (${expected})\n`)
