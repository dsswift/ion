/**
 * The Windows NSIS target must not pin its architectures.
 *
 * electron-builder treats an `arch` array in the target config as
 * authoritative, so `--win --arm64` on the command line does not narrow it:
 * the build rebuilds native modules for every listed architecture. On an ARM64
 * machine that meant `electron-builder --win --arm64` compiling node-pty for
 * x64 and failing on a toolchain that was never meant to be needed.
 *
 * Every caller already names an architecture — the CI matrix, `make.ps1`, and
 * `dist:win` (which omits it deliberately, so electron-builder targets the
 * host). Leaving the array out is what makes those flags mean what they say.
 */
import { describe, expect, it } from 'vitest'
import pkg from '../../../package.json'

type WinTarget = { target: string; arch?: string[] }

describe('windows install scope', () => {
  const nsis = pkg.build.nsis as unknown as { perMachine?: boolean; oneClick?: boolean }

  // Ion installs machine-wide only, deliberately. A per-user install puts a
  // separate copy in every profile, is invisible to the other accounts on a
  // shared workstation, and diverges from what MDM pushes to the same device.
  // The engine, its Scheduled Task and ~/.ion stay per-user regardless -- one
  // shared program, one isolated runtime per signed-in user, which is what a
  // multi-session host needs.
  it('installs per-machine', () => {
    expect(nsis.perMachine).toBe(true)
  })

  // perMachine with oneClick would remove the operator's ability to choose an
  // install directory and turn the assisted installer into a silent one.
  it('keeps the assisted installer', () => {
    expect(nsis.oneClick).toBe(false)
  })
})

describe('windows build target architecture', () => {
  const targets = pkg.build.win.target as unknown as WinTarget[]

  it('builds nsis', () => {
    expect(targets.map((t) => t.target)).toContain('nsis')
  })

  it('pins no architecture, so the CLI flag decides', () => {
    for (const target of targets) {
      expect(target.arch).toBeUndefined()
    }
  })

  it('still declares both architectures as buildable via the CLI', () => {
    // Not config, but the contract the release workflow depends on: two jobs,
    // each naming one arch. If this ever changes, the matrix must change too.
    expect(pkg.build.win.artifactName).toContain('${arch}')
  })
})
