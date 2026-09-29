// resolve-package.js — find an installed dependency wherever npm put it.
//
// ── Why a fixed node_modules/ path is wrong here ─────────────────────────────
// The repository is an npm workspace, so a dependency desktop declares may be
// installed in desktop/node_modules OR hoisted to the workspace root. A path
// joined to a fixed node_modules/ is correct in exactly one of those layouts
// and silently wrong in the other: under a hoisted install the setup check
// found no electron and refused to build, and every patch below degraded to a
// logged skip that looked routine.
//
// So resolution walks the node_modules chain the way node itself does —
// directory presence only, never `require.resolve`, because a package that
// declares `exports` without a `./package.json` entry makes that throw for
// reasons that have nothing to do with whether it is installed.
const fs = require('fs')
const path = require('path')

const DESKTOP_DIR = path.join(__dirname, '..')

/**
 * Absolute directory of an installed package, or undefined when it is absent.
 *
 * @param {string} name Package name, e.g. 'electron' or 'app-builder-lib'.
 * @param {string} fromDir Directory to start the walk from.
 * @returns {string|undefined}
 */
function packageDir(name, fromDir = DESKTOP_DIR) {
  let dir = path.resolve(fromDir)
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name)
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * A path INSIDE an installed package, or undefined when the package is absent.
 * Callers that patch a specific file ask for it this way rather than joining
 * their own node_modules prefix.
 *
 * @param {string} name Package name.
 * @param {...string} segments Path segments below the package root.
 * @returns {string|undefined}
 */
function packagePath(name, ...segments) {
  const dir = packageDir(name)
  return dir ? path.join(dir, ...segments) : undefined
}

/**
 * Installed version of a package, or '' when it is absent or unreadable.
 * Returns a string rather than throwing because its callers are shell scripts
 * comparing the result against a minimum.
 *
 * @param {string} name Package name.
 * @param {string} fromDir Directory to start the walk from.
 * @returns {string}
 */
function packageVersion(name, fromDir = DESKTOP_DIR) {
  const dir = packageDir(name, fromDir)
  if (!dir) return ''
  try {
    return require(path.join(dir, 'package.json')).version || ''
  } catch {
    return ''
  }
}

module.exports = { packageDir, packagePath, packageVersion }
