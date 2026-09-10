import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { patchNsisArm64 } from '../../../scripts/patch-nsis-arm64.js'

// The shape app-builder-lib ships: the per-machine install directory upgrades
// to the 64-bit Program Files only under APP_64, which an ARM64-only build
// never defines.
const UNPATCHED = `!macro setInstallModePerAllUsers
    \${else}
      StrCpy $0 "$PROGRAMFILES"
      !ifdef APP_64
        \${if} \${RunningX64}
          StrCpy $0 "$PROGRAMFILES64"
        \${endif}
      !endif

      StrCpy $INSTDIR "$0\\\${APP_FILENAME}"
    \${endif}
!macroend
`

describe('patchNsisArm64', () => {
  let dir: string
  let target: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-nsis-arm64-test-'))
    target = join(dir, 'multiUser.nsh')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('adds an ARM64 branch that selects the native Program Files', () => {
    writeFileSync(target, UNPATCHED)
    expect(patchNsisArm64(target)).toBe('patched')

    const out = readFileSync(target, 'utf8')
    expect(out).toContain('!ifdef APP_ARM64')
    expect(out).toContain('${if} ${IsNativeARM64}')
    // The x64 branch must survive untouched: a combined build still needs it.
    expect(out).toContain('${if} ${RunningX64}')
    // Both branches land on the 64-bit directory, and the 32-bit default
    // remains only as the fallback it was always meant to be.
    expect(out.match(/StrCpy \$0 "\$PROGRAMFILES64"/g)).toHaveLength(2)
  })

  it('is idempotent', () => {
    writeFileSync(target, UNPATCHED)
    patchNsisArm64(target)
    const once = readFileSync(target, 'utf8')
    expect(patchNsisArm64(target)).toBe('already')
    expect(readFileSync(target, 'utf8')).toBe(once)
  })

  // A silent no-op here reappears as an ARM64 install in Program Files (x86),
  // so an upstream reformat has to be loud rather than absorbed.
  it('reports rather than guesses when upstream changes shape', () => {
    writeFileSync(target, '!macro setInstallModePerAllUsers\n  StrCpy $0 "$LOCALAPPDATA"\n!macroend\n')
    expect(patchNsisArm64(target)).toBe('unrecognised')
    expect(readFileSync(target, 'utf8')).not.toContain('APP_ARM64')
  })

  // postinstall aborts the entire npm install on a throw, and this file is
  // absent after `npm ci --ignore-scripts`.
  it('skips a missing file instead of throwing', () => {
    expect(patchNsisArm64(join(dir, 'nope.nsh'))).toBe('missing')
  })
})
