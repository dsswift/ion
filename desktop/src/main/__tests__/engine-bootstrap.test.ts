/**
 * engine-bootstrap, plist install + version check + kickstart tests.
 *
 * Pins the first-launch bootstrap contract:
 *   1. Plist template $HOME substitution works correctly.
 *   2. Version-mismatched binary triggers a copy.
 *   3. Version-matched binary skips the copy.
 *   4. launchctl kickstart -k force-restarts ONLY when the plist or binary
 *      changed; an unchanged relaunch uses a non-destructive kickstart (no -k)
 *      so the persistent daemon and its in-flight work are not killed.
 *   5. No-op on non-darwin platforms.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Track side effects.
const execSyncCalls: string[] = []
const execFileSyncCalls: Array<{ file: string; args: string[] }> = []
const copiedFiles: Array<{ src: string; dst: string }> = []
let writtenFiles: Record<string, string> = {}
let fakeFs: Record<string, string> = {}

vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    execSyncCalls.push(cmd)
    return ''
  }),
  execFileSync: vi.fn((file: string, args: string[], _opts?: any) => {
    execFileSyncCalls.push({ file, args })
    if (args[0] === 'version') {
      // Bundled binary returns 2.0.0, installed returns 1.0.0 by default.
      if (file === '/bundled/ion') return 'ion-engine 2.0.0'
      if (file === '/Users/testuser/.ion/bin/ion') return 'ion-engine 1.0.0'
      return 'ion-engine dev'
    }
    if (args[0] === 'install-assets') return '==> install-assets complete'
    return ''
  }),
}))

vi.mock('fs', () => ({
  existsSync: vi.fn((p: string) => p in fakeFs),
  readFileSync: vi.fn((p: string) => fakeFs[p] || ''),
  writeFileSync: vi.fn((p: string, content: string) => {
    writtenFiles[p] = typeof content === 'string' ? content : String(content)
    fakeFs[p] = writtenFiles[p]
  }),
  mkdirSync: vi.fn(),
  copyFileSync: vi.fn((src: string, dst: string) => {
    copiedFiles.push({ src, dst })
    fakeFs[dst] = fakeFs[src] || ''
  }),
  chmodSync: vi.fn(),
}))

vi.mock('os', () => ({
  homedir: () => '/Users/testuser',
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
}))

const originalPlatform = process.platform
let platformOverride: string | null = null

beforeEach(() => {
  execSyncCalls.length = 0
  execFileSyncCalls.length = 0
  copiedFiles.length = 0
  writtenFiles = {}
  fakeFs = {}
  vi.clearAllMocks()
  // Pin to darwin so that the darwin-branch code paths execute regardless of
  // the CI host OS. The production guard (process.platform !== 'darwin') is
  // exercised by the dedicated no-op test below, which explicitly sets 'linux'.
  // Without this pin the darwin tests silently pass on macOS (where the real
  // platform IS darwin) but fail on the Linux CI container where the early-exit
  // branch fires and nothing is written/copied/exec'd.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  platformOverride = 'darwin'
})

afterEach(() => {
  if (platformOverride !== null) {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    platformOverride = null
  }
})

// We test the exported helpers + ensureEngineDaemon by mocking findPlistTemplate
// and findBundledBinary at the module boundary rather than trying to match
// filesystem paths from __dirname.
//
// Strategy: import the real module but pre-seed fakeFs with the paths that the
// module's find* helpers will probe. We know the candidates from the source code.

// For a simpler test, we mock the bootstrap module's internal find functions.
// Since they are exported, we can use vi.spyOn or re-mock. But ensureEngineDaemon
// calls them internally, so we mock at the fs level: make existsSync return true
// for the specific paths the find functions will check.

// The find functions check candidates starting with process.resourcesPath.
// In tests, process.resourcesPath is undefined, so they fall to the repo-relative paths.
// The repo-relative paths use __dirname (of the bootstrap module), which is
// desktop/src/main/ in the compiled output. Let's trace:
//   findPlistTemplate candidate 2: join(__dirname, '..', '..', '..', 'packaging', 'launchd', filename)
//   findBundledBinary candidate 2: join(__dirname, '..', '..', '..', 'engine', 'bin', 'ion')

import { execFileSync } from 'child_process'
import path from 'path'

// Bootstrap module __dirname is desktop/src/main in dev.
const bootstrapDir = path.join(__dirname, '..')
const plistTemplatePath = path.resolve(bootstrapDir, '..', '..', '..', 'packaging', 'launchd', 'com.ion.engine.plist')
const bundledBinaryPath = path.resolve(bootstrapDir, '..', '..', '..', 'engine', 'bin', 'ion')

import { ensureEngineDaemon, restartEngineDaemon, PLIST_LABEL } from '../engine-bootstrap'
describe('engine-bootstrap', () => {
  it('substitutes $HOME in the plist template', async () => {
    // Seed the template at the path findPlistTemplate will check.
    fakeFs[plistTemplatePath] = '<string>$HOME/.ion/bin/ion</string>\n<string>$HOME/.ion/engine.sock</string>'

    // Provide the destination binary so install-assets runs.
    const destBinary = '/Users/testuser/.ion/bin/ion'
    fakeFs[destBinary] = 'binary'

    await ensureEngineDaemon()

    // Find the written plist.
    const plistDest = '/Users/testuser/Library/LaunchAgents/com.ion.engine.plist'
    expect(writtenFiles[plistDest]).toBeDefined()
    expect(writtenFiles[plistDest]).not.toContain('$HOME')
    expect(writtenFiles[plistDest]).toContain('/Users/testuser/.ion/bin/ion')
    expect(writtenFiles[plistDest]).toContain('/Users/testuser/.ion/engine.sock')
  })

  it('copies the binary when versions differ', async () => {
    fakeFs[plistTemplatePath] = '<string>$HOME/.ion/bin/ion</string>'
    fakeFs[bundledBinaryPath] = 'bundled-binary'

    const destBinary = '/Users/testuser/.ion/bin/ion'
    fakeFs[destBinary] = 'old-binary'

    // Override execFileSync to return different versions per path.
    vi.mocked(execFileSync).mockImplementation((file: any, args: any) => {
      execFileSyncCalls.push({ file, args })
      if (args[0] === 'version') {
        if (file === bundledBinaryPath) return 'ion-engine 2.0.0'
        if (file === destBinary) return 'ion-engine 1.0.0'
      }
      if (args[0] === 'install-assets') return 'done'
      return '' as any
    })

    await ensureEngineDaemon()

    expect(copiedFiles.length).toBe(1)
    expect(copiedFiles[0].src).toBe(bundledBinaryPath)
    expect(copiedFiles[0].dst).toBe(destBinary)

    // install-assets must run from the BUNDLED binary, not the installed copy.
    const installAssetsCall = execFileSyncCalls.find((c) => c.args[0] === 'install-assets')
    expect(installAssetsCall).toBeDefined()
    expect(installAssetsCall!.file).toBe(bundledBinaryPath)
    expect(installAssetsCall!.file).not.toBe(destBinary)
  })

  it('skips binary copy when versions match', async () => {
    fakeFs[plistTemplatePath] = '<string>$HOME/.ion/bin/ion</string>'
    fakeFs[bundledBinaryPath] = 'binary'

    const destBinary = '/Users/testuser/.ion/bin/ion'
    fakeFs[destBinary] = 'binary'

    vi.mocked(execFileSync).mockImplementation((_file: any, args: any) => {
      execFileSyncCalls.push({ file: _file, args })
      if (args[0] === 'version') return 'ion-engine 2.0.0' // same version
      if (args[0] === 'install-assets') return 'done'
      return '' as any
    })

    await ensureEngineDaemon()

    expect(copiedFiles.length).toBe(0)

    // install-assets must still run from the BUNDLED binary even when the
    // installed copy is version-matched (it installs SDK/ion-meta, not just binary).
    const installAssetsCall = execFileSyncCalls.find((c) => c.args[0] === 'install-assets')
    expect(installAssetsCall).toBeDefined()
    expect(installAssetsCall!.file).toBe(bundledBinaryPath)
  })

  it('runs install-assets from the bundled binary, not the installed binary', async () => {
    // This pins the root-cause fix: install-assets resolves its asset root (extensions/
    // SDK and ion-meta) by walking up from the executable directory. The extensions/
    // tree ships at Contents/Resources/engine/extensions/ — adjacent to srcBinary —
    // but NOT next to destBinary (~/.ion/bin/ion). Running from destBinary would cause
    // install-assets to fail to find any assets to install.
    fakeFs[plistTemplatePath] = '<string>$HOME/.ion/bin/ion</string>'
    fakeFs[bundledBinaryPath] = 'bundled-binary'

    const destBinary = '/Users/testuser/.ion/bin/ion'
    fakeFs[destBinary] = 'old-binary'

    vi.mocked(execFileSync).mockImplementation((file: any, args: any) => {
      execFileSyncCalls.push({ file, args })
      if (args[0] === 'version') {
        if (file === bundledBinaryPath) return 'ion-engine 2.0.0'
        if (file === destBinary) return 'ion-engine 1.0.0'
      }
      if (args[0] === 'install-assets') return '==> install-assets complete'
      return '' as any
    })

    await ensureEngineDaemon()

    const installAssetsCall = execFileSyncCalls.find((c) => c.args[0] === 'install-assets')
    expect(installAssetsCall).toBeDefined()
    // Must use the bundled path (Contents/Resources/engine/ion), not ~/.ion/bin/ion.
    expect(installAssetsCall!.file).toBe(bundledBinaryPath)
    expect(installAssetsCall!.file).not.toBe(destBinary)
  })

  it('force-restarts with kickstart -k when the plist was (re)written', async () => {
    fakeFs[plistTemplatePath] = '<string>$HOME/.ion/bin/ion</string>'

    const destBinary = '/Users/testuser/.ion/bin/ion'
    fakeFs[destBinary] = 'binary'

    // No pre-existing plist dest in fakeFs, so the plist is written this run
    // (plistChanged=true). The force-restart (-k) is justified — the daemon
    // must pick up the new plist.

    await ensureEngineDaemon()

    const bootstrapCall = execSyncCalls.find((c) => c.includes('launchctl bootstrap'))
    const kickstartCall = execSyncCalls.find((c) => c.includes('launchctl kickstart'))
    expect(bootstrapCall).toBeDefined()
    expect(kickstartCall).toBeDefined()
    expect(kickstartCall).toContain('com.ion.engine')
    expect(kickstartCall).toContain('-k')
  })

  it('force-restarts with kickstart -k when a new binary was copied', async () => {
    fakeFs[plistTemplatePath] = '<string>$HOME/.ion/bin/ion</string>'
    fakeFs[bundledBinaryPath] = 'bundled-binary'

    const destBinary = '/Users/testuser/.ion/bin/ion'
    fakeFs[destBinary] = 'old-binary'

    // Pre-write the plist dest with the exact rendered content so the plist is
    // UNCHANGED this run — the only change is the binary copy (binaryUpdated=true).
    const plistDest = '/Users/testuser/Library/LaunchAgents/com.ion.engine.plist'
    fakeFs[plistDest] = '<string>/Users/testuser/.ion/bin/ion</string>'

    vi.mocked(execFileSync).mockImplementation((file: any, args: any) => {
      execFileSyncCalls.push({ file, args })
      if (args[0] === 'version') {
        if (file === bundledBinaryPath) return 'ion-engine 2.0.0'
        if (file === destBinary) return 'ion-engine 1.0.0'
      }
      if (args[0] === 'install-assets') return 'done'
      return '' as any
    })

    await ensureEngineDaemon()

    // Binary copied → force-restart is justified.
    expect(copiedFiles.length).toBe(1)
    const kickstartCall = execSyncCalls.find((c) => c.includes('launchctl kickstart'))
    expect(kickstartCall).toBeDefined()
    expect(kickstartCall).toContain('-k')
  })

  it('does NOT force-restart (no -k) when neither plist nor binary changed', async () => {
    fakeFs[plistTemplatePath] = '<string>$HOME/.ion/bin/ion</string>'
    fakeFs[bundledBinaryPath] = 'binary'

    const destBinary = '/Users/testuser/.ion/bin/ion'
    fakeFs[destBinary] = 'binary'

    // Pre-write the plist dest with the EXACT rendered content so Step 1 skips
    // the write (plistChanged=false). Versions match so Step 2 skips the copy
    // (binaryUpdated=false). The persistent daemon must be left running.
    const plistDest = '/Users/testuser/Library/LaunchAgents/com.ion.engine.plist'
    fakeFs[plistDest] = '<string>/Users/testuser/.ion/bin/ion</string>'

    vi.mocked(execFileSync).mockImplementation((_file: any, args: any) => {
      execFileSyncCalls.push({ file: _file, args })
      if (args[0] === 'version') return 'ion-engine 2.0.0' // same version both sides
      if (args[0] === 'install-assets') return 'done'
      return '' as any
    })

    await ensureEngineDaemon()

    // Nothing changed.
    expect(copiedFiles.length).toBe(0)
    expect(writtenFiles[plistDest]).toBeUndefined()

    // bootstrap still runs (idempotent; loads the agent if not loaded).
    const bootstrapCall = execSyncCalls.find((c) => c.includes('launchctl bootstrap'))
    expect(bootstrapCall).toBeDefined()

    // kickstart runs but WITHOUT -k — a healthy daemon is not killed.
    const kickstartCall = execSyncCalls.find((c) => c.includes('launchctl kickstart'))
    expect(kickstartCall).toBeDefined()
    expect(kickstartCall).toContain('com.ion.engine')
    expect(kickstartCall).not.toContain('-k')
  })

  it('is a no-op on non-darwin platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    platformOverride = 'linux'

    await ensureEngineDaemon()

    expect(Object.keys(writtenFiles).length).toBe(0)
    expect(execSyncCalls.length).toBe(0)
    expect(copiedFiles.length).toBe(0)
  })
})

describe('restartEngineDaemon', () => {
  it('force-restarts the daemon with kickstart -k so it re-reads engine.json', () => {
    // darwin is pinned in beforeEach.
    const ok = restartEngineDaemon()

    expect(ok).toBe(true)
    const kickstartCall = execSyncCalls.find((c) => c.includes('launchctl kickstart'))
    expect(kickstartCall).toBeDefined()
    // Force-restart (-k) is REQUIRED: a plain kickstart is a no-op on a running
    // daemon and would not recycle the process to re-read config.
    expect(kickstartCall).toContain('-k')
    expect(kickstartCall).toContain(PLIST_LABEL)
    // It must NOT bootout — the daemon is recycled in place, not stopped.
    expect(execSyncCalls.some((c) => c.includes('bootout'))).toBe(false)
  })

  it('is a no-op on non-darwin platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    platformOverride = 'linux'

    const ok = restartEngineDaemon()

    expect(ok).toBe(false)
    expect(execSyncCalls.length).toBe(0)
  })
})
