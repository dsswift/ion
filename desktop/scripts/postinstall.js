#!/usr/bin/env node
// postinstall.js — cross-platform postinstall steps, replacing the three
// bash scripts electron-builder install-app-deps used to chain
// (patch-dev-icon.sh, patch-zustand.sh, setup-claude-symlinks.sh). Node
// runs identically on macOS and Windows; bash does not exist by default on
// Windows, which is what forced this port (manifest contract C6).
const { execFileSync } = require('child_process')
const { copyFileSync, existsSync, utimesSync } = require('fs')
const path = require('path')

const { patchZustand } = require('./patch-zustand')
const { patchNsisArm64 } = require('./patch-nsis-arm64')

const DESKTOP_DIR = path.join(__dirname, '..')

/**
 * Swap the dev Dock icon by copying resources/icon.icns into the extracted
 * Electron.app bundle. Ported from patch-dev-icon.sh, including its
 * self-healing contract: the bundle is not guaranteed to exist when this runs
 * (an interrupted install, a failed download, or a prior
 * `npm ci --ignore-scripts` all leave electron/dist/ unpopulated), and this is
 * a cosmetic patch. A missing bundle must degrade to a logged skip, never to a
 * thrown error — the postinstall chain aborts the whole `npm install` on a
 * throw, and that failure used to surface as a bogus Xcode toolchain error.
 *
 * @param {string} desktopDir Root to resolve node_modules/ and resources/ from.
 */
function patchDevIcon(desktopDir = DESKTOP_DIR) {
  // macOS-only: the Electron.app bundle icon is a Dock cosmetic with no
  // counterpart on Windows or Linux.
  if (process.platform !== 'darwin') return

  const electronApp = path.join(desktopDir, 'node_modules', 'electron', 'dist', 'Electron.app')
  const bundleResources = path.join(electronApp, 'Contents', 'Resources')
  const iconSrc = path.join(desktopDir, 'resources', 'icon.icns')
  const electronInstall = path.join(desktopDir, 'node_modules', 'electron', 'install.js')

  if (!existsSync(iconSrc)) {
    console.log('patch-dev-icon: no resources/icon.icns; nothing to patch')
    return
  }

  if (!existsSync(electronApp)) {
    if (existsSync(electronInstall)) {
      console.log('patch-dev-icon: electron dist/ missing, running electron install.js to extract binary')
      try {
        execFileSync('node', [electronInstall], { stdio: 'inherit', cwd: desktopDir })
      } catch (err) {
        console.error(`patch-dev-icon: electron install.js failed: ${err}`)
      }
    }
    if (!existsSync(electronApp)) {
      console.error('patch-dev-icon: electron dist/ still missing; skipping icon patch (non-fatal)')
      return
    }
  }

  if (!existsSync(bundleResources)) {
    console.error('patch-dev-icon: electron bundle has no Contents/Resources; skipping icon patch (non-fatal)')
    return
  }

  copyFileSync(iconSrc, path.join(bundleResources, 'electron.icns'))
  // Touch the bundle so macOS invalidates its cached icon for it.
  const now = new Date()
  utimesSync(electronApp, now, now)
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', electronApp], { stdio: 'ignore' })
  } catch (err) {
    // Ad-hoc re-signing is cosmetic too: an unsigned dev bundle still runs.
    console.error(`patch-dev-icon: ad-hoc codesign failed, dev icon may not refresh: ${err}`)
  }
  console.log('patch-dev-icon: dev icon patched')
}

function main() {
  patchZustand(path.join(DESKTOP_DIR, 'node_modules', 'zustand', 'esm', 'react.mjs'))
  patchNsisArm64(
    path.join(DESKTOP_DIR, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'multiUser.nsh'),
  )
  patchDevIcon()

  if (process.platform !== 'win32') {
    // The Claude Code symlink helper is bash; Windows has no bash by default,
    // and the symlink itself (CLAUDE.md -> AGENTS.md) is a convenience for
    // Claude Code CLI users, not something the packaged Ion app depends on.
    const symlinkScript = path.join(DESKTOP_DIR, '..', 'scripts', 'setup-claude-symlinks.sh')
    execFileSync('bash', [symlinkScript], { stdio: 'inherit' })
  }

  console.log('postinstall: done')
}

if (require.main === module) main()

module.exports = { patchDevIcon, main }
