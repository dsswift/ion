#!/usr/bin/env node
const { readFileSync, mkdtempSync, rmSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

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

const expected = process.argv[2]
const appPath = process.argv[3]
const pkgPath = process.argv[4]
if (!expected || !appPath || !pkgPath) {
  fail('usage: check-release-version.js <version> <Ion.app> <Ion.pkg>')
}

const packageVersionFromManifest = JSON.parse(readFileSync('package.json', 'utf8')).version
if (packageVersionFromManifest !== expected) fail(`package.json=${packageVersionFromManifest}, expected=${expected}`)

const plist = `${appPath}/Contents/Info.plist`
const shortVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], { encoding: 'utf8' }).trim()
const bundleVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', plist], { encoding: 'utf8' }).trim()
if (shortVersion !== expected) fail(`CFBundleShortVersionString=${shortVersion}, expected=${expected}`)
if (bundleVersion !== expected) fail(`CFBundleVersion=${bundleVersion}, expected=${expected}`)

const pkgVersion = packageVersion(pkgPath)
if (pkgVersion !== expected) fail(`PKG version=${pkgVersion}, expected=${expected}`)

process.stdout.write(`release-version check: OK (${expected})\n`)
