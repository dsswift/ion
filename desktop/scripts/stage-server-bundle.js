#!/usr/bin/env node
// stage-server-bundle.js — build the Studio server and place its bundle
// inside the desktop tree at dist/server, where electron-builder ships it.
//
// The desktop spawns server/dist/main.js as a child process and the Studio
// window reaches the LOCAL environment only through it, so the server is
// part of the launch path. It ships unpacked (asarUnpack "dist/server/**")
// so its one native external, node-pty, resolves by Node's ordinary upward
// walk to app.asar.unpacked/node_modules. It has to be an in-project path:
// a `files` entry sourced from ../server/dist lands in the asar with its
// unpack pattern matched relative to that outside directory, so nothing
// matched and the child died on its first import. A copy under
// Resources/server via extraResources had no node_modules above it at all.
//
// Used by build-dev-app.js, the dist:win script, and the release workflow.
const { execFileSync } = require('node:child_process')
const { cpSync, rmSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const repoRoot = path.join(__dirname, '..', '..')
const source = path.join(repoRoot, 'server', 'dist')
const target = path.join(__dirname, '..', 'dist', 'server')

// A local build (build-dev-app.js) passes `devRepoRoot`; the release
// workflow calls this script directly and passes nothing. The SSH door reads
// DEV_ROOT to learn it is a development desktop whose server version has no
// published release, and ships the bundle packaged under
// <repo>/build/deploy instead of asking GitHub for a release that does not
// exist. Packaged-or-not is not the signal: `make desktop` is packaged too.
function stageServerBundle({ devRepoRoot } = {}) {
  execFileSync('npm', ['-w', 'server', 'run', 'build'], { stdio: 'inherit', cwd: repoRoot, shell: true })
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true })
  // The SSH door (main/connections/ssh/ssh-bootstrap.ts) pipes the same
  // installer a consumer curls to the remote host and pins the server
  // version this desktop shipped with; both ride beside the server bundle.
  cpSync(path.join(repoRoot, 'scripts', 'install-studio-server.sh'), path.join(target, 'install-studio-server.sh'))
  cpSync(path.join(repoRoot, 'server', 'VERSION'), path.join(target, 'VERSION'))
  // The server's Format Versions, read by `ion studio status` on the host
  // without starting anything. The engine's come from its own binary.
  writeFileSync(path.join(target, 'compat.json'), execFileSync(process.execPath, [path.join(target, 'compat.js')], { encoding: 'utf8' }))
  if (devRepoRoot) {
    writeFileSync(path.join(target, 'DEV_ROOT'), `${path.resolve(devRepoRoot)}\n`)
    console.log(`stage-server-bundle: development desktop, DEV_ROOT=${path.resolve(devRepoRoot)}`)
  }
  console.log(`stage-server-bundle: ${source} -> ${target}`)
}

module.exports = { stageServerBundle }

if (require.main === module) stageServerBundle()
