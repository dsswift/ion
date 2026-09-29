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

// The Studio server ships inside the app at dist/server (unpacked), so its
// bundle must be current before electron-builder collects it. Nothing else in
// the desktop build produces it. DEV_ROOT marks this as a development
// desktop so the SSH door installs the locally packaged server bundle.
require('./stage-server-bundle').stageServerBundle({ devRepoRoot: path.join(__dirname, '..', '..') })

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

// The packaged app must load its own module graph. Two installs in a row
// reached the operator's desktop as a "Cannot find module" dialog with every
// build step green; this is the step that turns that into a failed build.
const { checkAsar, findBuiltAsar, formatProblems } = require('./check-packaged-requires')
const asarPath = findBuiltAsar()
if (!asarPath) throw new Error('build-dev-app: electron-builder produced no app.asar under release/')
const problems = checkAsar(asarPath)
if (problems.length > 0) {
  throw new Error(
    `build-dev-app: ${asarPath} cannot load its own module graph. These loads fail at launch:\n` +
      formatProblems(problems),
  )
}
console.log(`build-dev-app: ${asarPath} loads every module its bundles name`)
