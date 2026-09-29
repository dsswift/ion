#!/usr/bin/env node
// node-pty-spawn-helper.js — make node-pty's prebuilt `spawn-helper` executable.
//
// On macOS and Linux node-pty forks the shell through a small prebuilt binary,
// `prebuilds/<platform>-<arch>/spawn-helper`. npm extracts that file 0644 (the
// tarball carries no execute bit and node-pty's postinstall never sets one),
// and a non-executable helper makes EVERY terminal fail with the one-line
// "posix_spawnp failed." -- in the dev tree, in the packaged desktop, and on
// a headless deploy alike. The packaged desktop shipped that way once: the
// bench terminal opened to a blinking cursor and never a shell.
//
// Two callers, one implementation:
//   - the repo's root `postinstall` (`npm install` / `make bootstrap`), so a
//     dev tree's node_modules copy works;
//   - `desktop/scripts/afterPack.js`, on the copy electron-builder places in
//     app.asar.unpacked, so the installed app works. pkgbuild preserves the
//     mode it finds, so fixing it there is what fixes /Applications.
// The server also repairs the bit itself at spawn time when it can
// (`server/src/terminal/terminal-spawn-helper.ts`); that backstop cannot
// reach a root-owned /Applications bundle, which is why the build sets it.
const fs = require('node:fs')
const path = require('node:path')

/**
 * Every `prebuilds/<platform>-<arch>/spawn-helper` that exists under a
 * node-pty package directory. Windows prebuilds carry no helper (ConPTY needs
 * none), so they simply do not appear.
 *
 * @param {string} nodePtyDir Absolute path of an installed node-pty package.
 * @returns {string[]} Absolute helper paths, sorted for stable output.
 */
function spawnHelperPaths(nodePtyDir) {
  const prebuilds = path.join(nodePtyDir, 'prebuilds')
  if (!fs.existsSync(prebuilds)) return []
  return fs
    .readdirSync(prebuilds, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(prebuilds, d.name, 'spawn-helper'))
    .filter((p) => fs.existsSync(p))
    .sort()
}

/**
 * Set the execute bits on every helper under `nodePtyDir` that lacks them.
 *
 * @param {string} nodePtyDir Absolute path of an installed node-pty package.
 * @returns {{ fixed: string[], already: string[] }} Which helpers were changed
 *   and which were already executable. Throws when a chmod is refused: a
 *   build that cannot set the bit must not ship.
 */
function ensureSpawnHelpersExecutable(nodePtyDir) {
  const fixed = []
  const already = []
  for (const helper of spawnHelperPaths(nodePtyDir)) {
    const mode = fs.statSync(helper).mode
    if ((mode & 0o111) === 0o111) {
      already.push(helper)
      continue
    }
    fs.chmodSync(helper, (mode & 0o777) | 0o755)
    fixed.push(helper)
  }
  return { fixed, already }
}

/**
 * node-pty's helper path resolver (lib/unixTerminal.js) as shipped:
 *   helperPath.replace('app.asar', 'app.asar.unpacked')
 * A bare string replace maps `app.asar` -> `app.asar.unpacked` -- correct
 * for a module loaded from inside the archive, and wrong for one loaded from
 * the unpacked tree, where the path already reads `app.asar.unpacked` and
 * becomes `app.asar.unpacked.unpacked`. The Studio server runs from
 * `app.asar.unpacked/dist/server/main.js` and resolves node-pty beside it,
 * so every terminal it spawned in the installed app failed with the same
 * one-line "posix_spawnp failed." as the missing execute bit. The rewrite
 * below makes the replace skip a path that is already unpacked.
 */
const SHIPPED_RESOLVER = "helperPath.replace('app.asar', 'app.asar.unpacked')"
const SAFE_RESOLVER = "helperPath.replace(/app\\.asar(?!\\.unpacked)/, 'app.asar.unpacked')"

/**
 * Make node-pty's helper path resolver safe for a module loaded from an
 * `app.asar.unpacked` tree.
 *
 * @param {string} nodePtyDir Absolute path of an installed node-pty package.
 * @returns {'patched'|'already'|'unrecognised'|'missing'} What happened:
 *   the resolver was rewritten, was already safe, has a shape this script
 *   does not know (a newer node-pty; left untouched, the packaged check
 *   decides), or the file is absent.
 */
function ensureHelperPathUnpackSafe(nodePtyDir) {
  const file = path.join(nodePtyDir, 'lib', 'unixTerminal.js')
  if (!fs.existsSync(file)) return 'missing'
  const src = fs.readFileSync(file, 'utf8')
  if (src.includes(SAFE_RESOLVER)) return 'already'
  if (!src.includes(SHIPPED_RESOLVER)) return 'unrecognised'
  fs.writeFileSync(file, src.replace(SHIPPED_RESOLVER, SAFE_RESOLVER))
  return 'patched'
}

/** True when `unixTerminal.js` under `nodePtyDir` resolves the helper safely from an unpacked tree. */
function helperPathIsUnpackSafe(nodePtyDir) {
  const file = path.join(nodePtyDir, 'lib', 'unixTerminal.js')
  return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(SAFE_RESOLVER)
}

/**
 * Walk `node_modules` upward from `fromDir` the way node resolves a package,
 * returning node-pty's directory or undefined. Directory presence only: the
 * workspace hoists node-pty to the repo root, so a fixed path is wrong in one
 * of the two layouts.
 *
 * @param {string} fromDir
 * @returns {string|undefined}
 */
function findNodePtyDir(fromDir) {
  let dir = path.resolve(fromDir)
  for (;;) {
    const candidate = path.join(dir, 'node_modules', 'node-pty')
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function main() {
  if (process.platform === 'win32') {
    console.log('node-pty-spawn-helper: windows uses ConPTY; no spawn-helper to fix')
    return 0
  }
  const nodePtyDir = findNodePtyDir(process.cwd())
  if (!nodePtyDir) {
    // `npm ci --ignore-scripts` lanes and partial installs land here; the
    // server's own spawn-time repair covers a tree that is installed later.
    console.log('node-pty-spawn-helper: node-pty is not installed; nothing to fix')
    return 0
  }
  const { fixed, already } = ensureSpawnHelpersExecutable(nodePtyDir)
  for (const p of fixed) console.log(`node-pty-spawn-helper: set execute bit on ${p}`)
  if (fixed.length === 0) console.log(`node-pty-spawn-helper: ${already.length} helper(s) under ${nodePtyDir} already executable`)
  console.log(`node-pty-spawn-helper: helper path resolver ${ensureHelperPathUnpackSafe(nodePtyDir)}`)
  return 0
}

module.exports = { ensureSpawnHelpersExecutable, ensureHelperPathUnpackSafe, helperPathIsUnpackSafe, findNodePtyDir, spawnHelperPaths }

if (require.main === module) process.exit(main())
