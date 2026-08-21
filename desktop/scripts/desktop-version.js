const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const repoRoot = resolve(__dirname, '../..')

function readReleasedDesktopVersion() {
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'release-please-manifest.json'), 'utf8'))
  const version = manifest.desktop
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('release-please-manifest.json has no valid desktop version')
  }
  return version
}

function nextDevelopmentVersion(releasedVersion, shortSha, dirty = false) {
  const [major, minor] = releasedVersion.split('.').map(Number)
  return `${major}.${minor + 1}.0-dev.${shortSha}${dirty ? '.dirty' : ''}`
}

function resolveDesktopVersion() {
  if (process.env.ION_DESKTOP_VERSION) return process.env.ION_DESKTOP_VERSION
  const releasedVersion = readReleasedDesktopVersion()
  const shortSha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim().length > 0
  return nextDevelopmentVersion(releasedVersion, shortSha, dirty)
}

if (require.main === module) process.stdout.write(`${resolveDesktopVersion()}\n`)

module.exports = { nextDevelopmentVersion, readReleasedDesktopVersion, resolveDesktopVersion }
