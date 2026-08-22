#!/usr/bin/env node
const { readFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')

function fail(message) {
  process.stderr.write(`release-version check failed: ${message}\n`)
  process.exit(1)
}

const expected = process.argv[2]
const appPath = process.argv[3]
const pkgPath = process.argv[4]
if (!expected || !appPath || !pkgPath) {
  fail('usage: check-release-version.js <version> <Ion.app> <Ion.pkg>')
}

const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version
if (packageVersion !== expected) fail(`package.json=${packageVersion}, expected=${expected}`)

const plist = `${appPath}/Contents/Info.plist`
const shortVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist], { encoding: 'utf8' }).trim()
const bundleVersion = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleVersion', plist], { encoding: 'utf8' }).trim()
if (shortVersion !== expected) fail(`CFBundleShortVersionString=${shortVersion}, expected=${expected}`)
if (bundleVersion !== expected) fail(`CFBundleVersion=${bundleVersion}, expected=${expected}`)

const pkgInfo = execFileSync('pkgutil', ['--pkg-info-plist', pkgPath], { encoding: 'utf8' })
const pkgVersion = execFileSync('/usr/bin/plutil', ['-extract', 'pkg-version', 'raw', '-o', '-', '-'], { input: pkgInfo, encoding: 'utf8' }).trim()
if (pkgVersion !== expected) fail(`PKG version=${pkgVersion}, expected=${expected}`)

process.stdout.write(`release-version check: OK (${expected})\n`)
