#!/usr/bin/env node
// patch-nsis-arm64.js — CRITICAL: teach electron-builder's NSIS template that
// an ARM64 machine has a 64-bit Program Files.
//
// setInstallModePerAllUsers in app-builder-lib's multiUser.nsh defaults the
// per-machine install directory to $PROGRAMFILES, and upgrades it to
// $PROGRAMFILES64 only inside `!ifdef APP_64`. An installer built for ARM64
// alone defines APP_ARM64 and never APP_64, so the upgrade is skipped and a
// per-machine ARM64 install lands in C:\Program Files (x86) -- the directory
// reserved for 32-bit software, on a machine that runs none.
//
// The installer still reports success, so the damage is downstream and quiet:
// the Intune uninstall command, the detection script, and every documented
// verification step read %ProgramFiles%\Ion and find nothing there.
//
// The same NSIS template already knows how to ask this question -- its own
// check64BitAndSetRegView tests ${IsNativeARM64} to choose the 64-bit registry
// view. This adds the matching branch for the install directory.
//
// Remove this patch once app-builder-lib carries the ARM64 branch upstream.
const fs = require('fs')
const path = require('path')

// The whole APP_64 block is matched rather than a single line, so a reformat
// upstream fails loudly here instead of silently patching nothing.
const APP_64_BLOCK = `      StrCpy $0 "$PROGRAMFILES"
      !ifdef APP_64
        \${if} \${RunningX64}
          StrCpy $0 "$PROGRAMFILES64"
        \${endif}
      !endif
`

const WITH_ARM64 = `${APP_64_BLOCK}      !ifdef APP_ARM64
        \${if} \${IsNativeARM64}
          StrCpy $0 "$PROGRAMFILES64"
        \${endif}
      !endif
`

/**
 * Adds an APP_ARM64 branch beside the existing APP_64 one in multiUser.nsh, so
 * a per-machine ARM64 install resolves to the native Program Files. Idempotent:
 * a second call against an already-patched file is a no-op. A missing file is a
 * logged skip rather than a throw, because postinstall aborts the whole install
 * on a throw and this file is absent whenever electron-builder is not installed
 * (`npm ci --ignore-scripts`, a partial install).
 *
 * @param {string} filePath templates/nsis/multiUser.nsh inside app-builder-lib.
 * @returns {'patched' | 'already' | 'missing' | 'unrecognised'} what happened.
 */
function patchNsisArm64(filePath) {
  if (!fs.existsSync(filePath)) {
    console.log('nsis arm64 patch skipped \u2014 multiUser.nsh not present')
    return 'missing'
  }
  const contents = fs.readFileSync(filePath, 'utf8')
  if (contents.includes('!ifdef APP_ARM64')) {
    console.log('nsis arm64 install directory already patched')
    return 'already'
  }
  if (!contents.includes(APP_64_BLOCK)) {
    // Upstream changed the shape. Say so rather than pretending it worked: a
    // silent no-op here reappears as an installer in Program Files (x86).
    console.log('nsis arm64 patch NOT applied \u2014 multiUser.nsh no longer matches the expected shape')
    return 'unrecognised'
  }
  fs.writeFileSync(filePath, contents.replace(APP_64_BLOCK, WITH_ARM64))
  console.log('Patched NSIS per-machine install directory for ARM64')
  return 'patched'
}

module.exports = { patchNsisArm64 }

if (require.main === module) {
  patchNsisArm64(
    path.join(__dirname, '..', 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'multiUser.nsh'),
  )
}
