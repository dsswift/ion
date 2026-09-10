#!/usr/bin/env node
// build-dev-app.js — build a packaged local app with a truthful development
// identity, for whichever platform this script runs on. Release CI invokes
// electron-vite/electron-builder directly after stamping package.json; this
// script is the local `npm run dist` path. Ported from build-dev-app.sh so
// it runs on Windows too (manifest contract C6) — bash is not guaranteed
// there.
const { execFileSync } = require('child_process')
const path = require('path')

const desktopVersion = execFileSync('node', [path.join(__dirname, 'desktop-version.js')], { encoding: 'utf8' }).trim()
console.log(`Development version: ${desktopVersion}`)

const env = { ...process.env, ION_DESKTOP_VERSION: desktopVersion }

execFileSync('npx', ['electron-vite', 'build', '--mode', 'production'], { stdio: 'inherit', env, shell: true })

const platformArgs = process.platform === 'win32'
  ? ['--win', '--x64', '--dir']
  : ['--mac', '--dir']

execFileSync('npx', [
  'electron-builder',
  ...platformArgs,
  `-c.extraMetadata.version=${desktopVersion}`,
  ...(process.platform === 'darwin' ? [`-c.mac.bundleVersion=${desktopVersion}`] : []),
], { stdio: 'inherit', shell: true })
