#!/usr/bin/env node
// check-packaged-requires.js — prove the packaged app can load its own
// module graph before anyone launches it.
//
// The main and preload bundles leave real npm dependencies as bare
// `require("x")` calls, and electron-builder decides which packages land in
// app.asar. Nothing in the build ties the two together: a dependency that a
// bundle reaches for but the asar does not carry, or a shipped package that
// itself reaches for something never shipped, is invisible until the main
// process throws "Cannot find module" in a dialog on the operator's desktop,
// before its first log line. Two consecutive installs failed exactly that
// way — once on TypeScript source left external, once on zustand's root entry
// requiring react, a renderer-only devDependency the asar never carries.
//
// Static analysis cannot answer this honestly: zustand declares react as an
// optional peer while its entry requires it unconditionally, and a library's
// guarded optional requires would read as failures. So this script extracts
// the asar and actually loads every bare specifier the bundles name, from the
// bundle's own location inside the extracted tree, in a child process
// (`packaged-require-probe.js`). In production the child is the Electron
// binary running as Node, so native addons load against the ABI they were
// rebuilt for. It is run by build-dev-app.js after electron-builder and by
// the Windows dist script, so the build fails instead of the launch.
const asar = require('@electron/asar')
const { execFileSync } = require('node:child_process')
const { builtinModules } = require('node:module')
const { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } = require('node:fs')
const { spawnHelperPaths, helperPathIsUnpackSafe } = require('../../scripts/node-pty-spawn-helper')
const { tmpdir } = require('node:os')
const path = require('node:path')

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))

/**
 * Matches the ways an emitted bundle can load a module: a CJS `require('x')`,
 * a static `import ... from 'x'`, a side-effect `import 'x'`, and a dynamic
 * `import('x')`. The captured text is then held to npm's package-name
 * grammar, because `from "..."` also matches English inside log strings
 * ("who last touched this file", "a resize arrived with bad numbers").
 */
const LOAD = /(?:require\(\s*|import\s*\(\s*|from\s*|import\s*)['"]([^'"]+)['"]/g
const BARE_SPECIFIER = /^(?:node:)?(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w./-]+)?$/i

/** Every bare specifier loaded by the given source text, deduplicated. */
function bareSpecifiers(code) {
  const found = new Set()
  LOAD.lastIndex = 0
  let match
  while ((match = LOAD.exec(code)) !== null) {
    const specifier = match[1]
    if (specifier.startsWith('.') || specifier.startsWith('/')) continue
    if (BARE_SPECIFIER.test(specifier)) found.add(specifier)
  }
  return [...found]
}

/**
 * ws's optional native accelerators. ws requires them inside its own
 * try/catch and falls back to JavaScript when they are absent; the server
 * bundle inlines ws and keeps exactly these two external (see
 * server/scripts/build.mjs), so they appear as bare specifiers whose guard
 * a text scan cannot see. Nothing else is exempt.
 */
const OPTIONAL_NATIVE_ACCELERATORS = new Set(['bufferutil', 'utf-8-validate'])

/** Specifiers the Electron runtime provides itself, never from the asar. */
function providedByRuntime(specifier) {
  return BUILTINS.has(specifier) || specifier === 'electron' || specifier.startsWith('electron/')
}

/** Specifiers whose absence the loading code handles itself. */
function optionalAtRuntime(specifier) {
  return OPTIONAL_NATIVE_ACCELERATORS.has(specifier)
}

/**
 * Emitted main and preload artifacts under an extracted app dir, plus the
 * Studio server bundle the desktop spawns as a child (`dist/server/`, shipped
 * unpacked so its one native external, node-pty, resolves beside it).
 */
function bundleEntries(rootDir) {
  const entries = []
  for (const sub of ['dist/main', 'dist/preload', 'dist/server']) {
    const dir = path.join(rootDir, sub)
    if (!existsSync(dir)) continue
    for (const dirent of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!dirent.isFile() || !/\.(js|mjs|cjs)$/.test(dirent.name)) continue
      const full = path.join(dirent.parentPath, dirent.name)
      entries.push({ file: path.relative(rootDir, full), code: readFileSync(full, 'utf8') })
    }
  }
  return entries
}

/**
 * The Electron binary, run as Node, so the probe shares the packaged app's
 * Node version and native ABI. Falls back to this process's Node when
 * electron is not installed (CI lanes that run `npm ci --ignore-scripts`).
 */
function probeBinary() {
  try {
    const electronPath = require('electron')
    if (typeof electronPath === 'string' && existsSync(electronPath)) return electronPath
  } catch {
    // Electron absent or its binary not extracted: plain Node still proves
    // JavaScript resolution, which is the failure class seen so far.
  }
  return process.execPath
}

/**
 * Loads every bare specifier from each entry inside `rootDir` in a child
 * process anchored at that entry's location. Entries are `{ file, code }`
 * with `file` relative to `rootDir`.
 *
 * @returns {{ from: string, specifier: string, reason: string }[]} one row per
 *   load that fails; empty when every module the bundles name loads.
 */
function checkResolution(rootDir, entries, binary = probeBinary()) {
  rootDir = realpathSync(rootDir)
  const problems = []
  for (const { file, code } of entries) {
    const specifiers = bareSpecifiers(code).filter((s) => !providedByRuntime(s) && !optionalAtRuntime(s))
    if (specifiers.length === 0) continue
    const anchor = path.join(rootDir, file)
    const input = JSON.stringify({ rootDir, anchor, specifiers })
    const stdout = execFileSync(binary, [path.join(__dirname, 'packaged-require-probe.js'), input], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: '' },
      maxBuffer: 16 * 1024 * 1024,
    })
    for (const result of JSON.parse(stdout)) {
      if (result.error) problems.push({ from: file, specifier: result.specifier, reason: result.error })
    }
  }
  return problems
}

/**
 * node-pty's prebuilt `spawn-helper` must carry its execute bit in the
 * packed `.unpacked` tree, or every terminal in the installed app fails with
 * "posix_spawnp failed." (npm extracts it 0644; afterPack.js fixes it; this
 * is the check that the fix reached the artifact). Checked on the real
 * on-disk sibling rather than an asar extraction, because the runtime reads
 * the helper from that directory and the asar header records only what the
 * mode was when the archive was written. Windows carries no helper.
 *
 * @param {string} unpackedRoot The `app.asar.unpacked` directory beside the asar.
 * @param {NodeJS.Platform} platform
 * @returns {{ from: string, specifier: string, reason: string }[]}
 */
function checkSpawnHelpers(unpackedRoot, platform = process.platform) {
  if (platform === 'win32') return []
  const nodePtyDir = path.join(unpackedRoot, 'node_modules', 'node-pty')
  if (!existsSync(nodePtyDir)) return []
  const problems = []
  // The server resolves node-pty from this unpacked tree, where node-pty's
  // shipped resolver doubles the `.unpacked` suffix of the helper path and
  // every terminal fails with "posix_spawnp failed." afterPack rewrites it.
  if (!helperPathIsUnpackSafe(nodePtyDir)) {
    problems.push({
      from: path.relative(path.dirname(unpackedRoot), path.join(nodePtyDir, 'lib', 'unixTerminal.js')),
      specifier: 'helper path resolver',
      reason: 'still rewrites app.asar -> app.asar.unpacked unconditionally; loaded from the unpacked tree the helper path becomes app.asar.unpacked.unpacked and every terminal fails with "posix_spawnp failed."',
    })
  }
  for (const helper of spawnHelperPaths(nodePtyDir)) {
    const mode = statSync(helper).mode & 0o777
    if ((mode & 0o111) !== 0o111) {
      problems.push({
        from: path.relative(path.dirname(unpackedRoot), helper),
        specifier: 'execute bit',
        reason: `mode 0${mode.toString(8)} is not executable; every terminal would fail with "posix_spawnp failed."`,
      })
    }
  }
  return problems
}

/**
 * Extracts `asarPath` (and its sibling `.unpacked` tree, which holds the
 * native addons) to a temp dir and checks its bundles, then checks the
 * on-disk `.unpacked` tree's spawn-helper mode. Returns the problem rows;
 * the temp dir is removed either way.
 */
function checkAsar(asarPath, binary = probeBinary()) {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'ion-asar-check-'))
  try {
    asar.extractAll(asarPath, rootDir)
    const entries = bundleEntries(rootDir)
    if (entries.length === 0) {
      return [{ from: asarPath, specifier: 'dist/main', reason: 'no main or preload bundles in asar' }]
    }
    // The desktop spawns this file at launch and the Studio window reaches
    // the LOCAL environment only through it. An app without it opens to an
    // offline environment, so its absence is a launch failure too.
    if (!existsSync(path.join(rootDir, 'dist', 'server', 'main.js'))) {
      return [{ from: asarPath, specifier: 'dist/server/main.js', reason: 'Studio server bundle is not packaged' }]
    }
    return [
      ...checkResolution(rootDir, entries, binary),
      ...checkSpawnHelpers(`${asarPath}.unpacked`),
    ]
  } finally {
    rmSync(rootDir, { recursive: true, force: true })
  }
}

/** The app.asar electron-builder produced for this platform under release/. */
function findBuiltAsar(releaseDir = path.join(__dirname, '..', 'release')) {
  if (!existsSync(releaseDir)) return undefined
  for (const dirent of readdirSync(releaseDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue
    const candidates = [
      path.join(releaseDir, dirent.name, 'Ion.app', 'Contents', 'Resources', 'app.asar'),
      path.join(releaseDir, dirent.name, 'resources', 'app.asar'),
    ]
    const hit = candidates.find((c) => existsSync(c))
    if (hit) return hit
  }
  return undefined
}

function formatProblems(problems) {
  return problems.map(({ from, specifier, reason }) => `  ${from} -> ${specifier}: ${reason}`).join('\n')
}

function main(argv) {
  const asarPath = argv[0] || findBuiltAsar()
  if (!asarPath) {
    console.error('check-packaged-requires: no app.asar found under release/; pass its path')
    return 2
  }
  const binary = probeBinary()
  console.log(`check-packaged-requires: probing ${asarPath} with ${binary}`)
  const problems = checkAsar(asarPath, binary)
  if (problems.length === 0) {
    console.log('check-packaged-requires: every module the bundles name loads from the asar')
    return 0
  }
  console.error(
    'check-packaged-requires: the packaged app cannot load its own module graph. ' +
      'These loads fail at launch:\n' +
      formatProblems(problems),
  )
  return 1
}

module.exports = { bareSpecifiers, bundleEntries, checkAsar, checkResolution, checkSpawnHelpers, findBuiltAsar, formatProblems, probeBinary }

if (require.main === module) process.exit(main(process.argv.slice(2)))
