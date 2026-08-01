/**
 * engine-bootstrap, plist install + binary-identity check + kickstart tests.
 *
 * Pins the first-launch bootstrap contract:
 *   1. Plist template $HOME substitution works correctly.
 *   2. Content-changed binary triggers a copy.
 *   3. Content-matched binary skips the copy.
 *   4. A binary with the SAME `ion version` string but DIFFERENT bytes still
 *      triggers a copy + force-restart (the stale-daemon regression: identity
 *      is a content hash, not a version string).
 *   5. launchctl kickstart -k force-restarts ONLY when the plist or binary
 *      changed; an unchanged relaunch uses a non-destructive kickstart (no -k)
 *      so the persistent daemon and its in-flight work are not killed.
 *   6. No-op on non-darwin platforms.
 *   7. Kickstart is retried on transient launchctl failure, and the daemon is
 *      verified UP via a real socket probe before ensureEngineDaemon returns
 *      (the relaunch-handoff regression: a single swallowed `spawnSync
 *      ETIMEDOUT` left the engine down for the whole app session).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Track side effects.
const execSyncCalls: string[] = []
const execFileSyncCalls: Array<{ file: string; args: string[] }> = []
const copiedFiles: Array<{ src: string; dst: string }> = []
const renamedFiles: Array<{ src: string; dst: string }> = []
let writtenFiles: Record<string, string> = {}
let fakeFs: Record<string, string> = {}
// Armed by the kickstart-retry tests: the next N `launchctl kickstart`
// invocations throw (simulating the observed `spawnSync /bin/sh ETIMEDOUT`).
let kickstartFailuresRemaining = 0
// Socket-probe control for waitForEngineSocket: per-probe queue, then default.
let socketProbeResults: boolean[] = []
let socketDefaultReachable = true
let socketProbeCount = 0

vi.mock('net', () => ({
  createConnection: vi.fn(() => {
    socketProbeCount++
    const reachable = socketProbeResults.length > 0 ? socketProbeResults.shift()! : socketDefaultReachable
    const handlers: Record<string, () => void> = {}
    const conn = {
      once: (ev: string, cb: () => void) => {
        handlers[ev] = cb
        return conn
      },
      destroy: vi.fn(),
    }
    queueMicrotask(() => {
      handlers[reachable ? 'connect' : 'error']?.()
    })
    return conn
  }),
}))

vi.mock('child_process', () => ({
  // launchctl now runs through execFile (async) rather than execSync: a
  // synchronous call would block the Electron main thread, which is the stall
  // this path was fixed for. Invocations are still recorded as joined command
  // strings so the existing command-shape assertions read unchanged.
  execFile: vi.fn((file: string, args: string[], _opts: any, cb?: (err: Error | null, stdout?: string, stderr?: string) => void) => {
    const cmd = [file, ...args].join(' ')
    execSyncCalls.push(cmd)
    const done = typeof _opts === 'function' ? (_opts as typeof cb) : cb
    if (cmd.includes('kickstart') && kickstartFailuresRemaining > 0) {
      kickstartFailuresRemaining--
      done?.(new Error('spawnSync /bin/sh ETIMEDOUT'))
      return
    }
    done?.(null, '', '')
  }),
  execFileSync: vi.fn((file: string, args: string[], _opts?: any) => {
    execFileSyncCalls.push({ file, args })
    // Binary identity is decided by a content hash of the bytes (see hashBinary),
    // NOT by `ion version` — the engine binary is never exec'd for the copy
    // decision. execFileSync is used only for `install-assets`.
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
  renameSync: vi.fn((src: string, dst: string) => {
    renamedFiles.push({ src, dst })
    fakeFs[dst] = fakeFs[src] || ''
    delete fakeFs[src]
  }),
  chmodSync: vi.fn(),
}))

vi.mock('os', () => ({
  homedir: () => '/Users/testuser',
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  error: vi.fn(),
}))

const originalPlatform = process.platform
let platformOverride: string | null = null

beforeEach(() => {
  execSyncCalls.length = 0
  execFileSyncCalls.length = 0
  copiedFiles.length = 0
  renamedFiles.length = 0
  writtenFiles = {}
  fakeFs = {}
  kickstartFailuresRemaining = 0
  socketProbeResults = []
  socketDefaultReachable = true
  socketProbeCount = 0
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

  it('copies the binary when its content differs', async () => {
    fakeFs[plistTemplatePath] = '<string>$HOME/.ion/bin/ion</string>'
    fakeFs[bundledBinaryPath] = 'bundled-binary-bytes'

    const destBinary = '/Users/testuser/.ion/bin/ion'
    fakeFs[destBinary] = 'old-binary-bytes'

    await ensureEngineDaemon()

    // The copy must land on a STAGING path and reach the destination only via
    // rename, so the installed binary always gets a fresh inode. Copying onto
    // destBinary directly reuses the vnode, whose cached code-signing state
    // poisons every subsequent exec with SIGKILL "Taskgated Invalid Signature".
    expect(copiedFiles.length).toBe(1)
    expect(copiedFiles[0].src).toBe(bundledBinaryPath)
    expect(copiedFiles[0].dst).toBe(`${destBinary}.staging`)
    expect(copiedFiles[0].dst).not.toBe(destBinary)
    expect(renamedFiles).toEqual([{ src: `${destBinary}.staging`, dst: destBinary }])
    expect(fakeFs[destBinary]).toBe('bundled-binary-bytes')

    // install-assets must run from the BUNDLED binary, not the installed copy.
    const installAssetsCall = execFileSyncCalls.find((c) => c.args[0] === 'install-assets')
    expect(installAssetsCall).toBeDefined()
    expect(installAssetsCall!.file).toBe(bundledBinaryPath)
    expect(installAssetsCall!.file).not.toBe(destBinary)
  })

  it('skips binary copy when the content is identical', async () => {
    fakeFs[plistTemplatePath] = '<string>$HOME/.ion/bin/ion</string>'
    fakeFs[bundledBinaryPath] = 'identical-bytes'

    const destBinary = '/Users/testuser/.ion/bin/ion'
    fakeFs[destBinary] = 'identical-bytes'

    await ensureEngineDaemon()

    expect(copiedFiles.length).toBe(0)

    // install-assets must still run from the BUNDLED binary even when the
    // installed copy is content-matched (it installs the SDK, not just binary).
    const installAssetsCall = execFileSyncCalls.find((c) => c.args[0] === 'install-assets')
    expect(installAssetsCall).toBeDefined()
    expect(installAssetsCall!.file).toBe(bundledBinaryPath)
  })

  it('copies + force-restarts when the version string matches but the bytes differ', async () => {
    // The stale-daemon regression. A DMG-bundled engine and the installed
    // ~/.ion/bin/ion both reported `ion-engine dev` (neither build stamped a
    // version), so a version-string equality check treated a genuinely different
    // binary as identical: it skipped the copy AND the force-restart, leaving the
    // old daemon running. Identity is now a content hash, so different bytes are
    // detected even when the version string is identical.
    fakeFs[plistTemplatePath] = '<string>$HOME/.ion/bin/ion</string>'
    fakeFs[bundledBinaryPath] = 'NEW-engine-with-the-features'

    const destBinary = '/Users/testuser/.ion/bin/ion'
    fakeFs[destBinary] = 'OLD-engine-different-bytes'

    // Pre-write the plist dest with the exact rendered content so the plist is
    // UNCHANGED this run — the binary content is the ONLY thing that differs, so
    // the force-restart can only come from binaryUpdated.
    const plistDest = '/Users/testuser/Library/LaunchAgents/com.ion.engine.plist'
    fakeFs[plistDest] = '<string>/Users/testuser/.ion/bin/ion</string>'

    // Both binaries report the SAME version string — the exact condition that
    // fooled the old check. It must NOT save the copy now.
    vi.mocked(execFileSync).mockImplementation((file: any, args: any) => {
      execFileSyncCalls.push({ file, args })
      if (args[0] === 'version') return 'ion-engine dev' // identical on both sides
      if (args[0] === 'install-assets') return 'done'
      return '' as any
    })

    await ensureEngineDaemon()

    // The new binary is installed despite the matching version string
    // (staged copy + rename onto the destination).
    expect(copiedFiles.length).toBe(1)
    expect(copiedFiles[0].src).toBe(bundledBinaryPath)
    expect(copiedFiles[0].dst).toBe(`${destBinary}.staging`)
    expect(renamedFiles).toEqual([{ src: `${destBinary}.staging`, dst: destBinary }])

    // And the daemon is force-restarted so it actually runs the new binary.
    const kickstartCall = execSyncCalls.find((c) => c.includes('launchctl kickstart'))
    expect(kickstartCall).toBeDefined()
    expect(kickstartCall).toContain('-k')
  })

  it('runs install-assets from the bundled binary, not the installed binary', async () => {
    // This pins the root-cause fix: install-assets resolves its asset root (extensions/
    // SDK) by walking up from the executable directory. The extensions/
    // tree ships at Contents/Resources/engine/extensions/ — adjacent to srcBinary —
    // but NOT next to destBinary (~/.ion/bin/ion). Running from destBinary would cause
    // install-assets to fail to find any assets to install.
    fakeFs[plistTemplatePath] = '<string>$HOME/.ion/bin/ion</string>'
    fakeFs[bundledBinaryPath] = 'bundled-binary-bytes'

    const destBinary = '/Users/testuser/.ion/bin/ion'
    fakeFs[destBinary] = 'old-binary-bytes'

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
    fakeFs[bundledBinaryPath] = 'bundled-binary-bytes'

    const destBinary = '/Users/testuser/.ion/bin/ion'
    fakeFs[destBinary] = 'old-binary-bytes'

    // Pre-write the plist dest with the exact rendered content so the plist is
    // UNCHANGED this run — the only change is the binary copy (binaryUpdated=true).
    const plistDest = '/Users/testuser/Library/LaunchAgents/com.ion.engine.plist'
    fakeFs[plistDest] = '<string>/Users/testuser/.ion/bin/ion</string>'

    await ensureEngineDaemon()

    // Binary copied → force-restart is justified.
    expect(copiedFiles.length).toBe(1)
    const kickstartCall = execSyncCalls.find((c) => c.includes('launchctl kickstart'))
    expect(kickstartCall).toBeDefined()
    expect(kickstartCall).toContain('-k')
  })

  it('does NOT force-restart (no -k) when neither plist nor binary changed', async () => {
    fakeFs[plistTemplatePath] = '<string>$HOME/.ion/bin/ion</string>'
    fakeFs[bundledBinaryPath] = 'identical-bytes'

    const destBinary = '/Users/testuser/.ion/bin/ion'
    fakeFs[destBinary] = 'identical-bytes'

    // Pre-write the plist dest with the EXACT rendered content so Step 1 skips
    // the write (plistChanged=false). Binary content matches so Step 2 skips the
    // copy (binaryUpdated=false). The persistent daemon must be left running.
    const plistDest = '/Users/testuser/Library/LaunchAgents/com.ion.engine.plist'
    fakeFs[plistDest] = '<string>/Users/testuser/.ion/bin/ion</string>'

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
  it('force-restarts the daemon with kickstart -k so it re-reads engine.json', async () => {
    // darwin is pinned in beforeEach.
    const ok = await restartEngineDaemon()

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

  it('is a no-op on non-darwin platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    platformOverride = 'linux'

    const ok = await restartEngineDaemon()

    expect(ok).toBe(false)
    expect(execSyncCalls.length).toBe(0)
  })

  // REGRESSION: the watchdog measured a 5029ms main-thread stall spanning the
  // launchctl kickstart, because it ran through execSync. On the Electron main
  // thread that blocks the event loop outright, so every renderer IPC reply —
  // including the restore sequence's — waits for launchctl to return.
  //
  // The pin: launchctl is invoked through the ASYNC child_process surface. A
  // synchronous implementation cannot satisfy this, because the mock exposes no
  // execSync at all and the module would fail to import.
  it('REGRESSION: shells out asynchronously so the main thread is never blocked', async () => {
    const { execFile } = await import('child_process')

    const pending = restartEngineDaemon()
    // The call returns a promise: control is back on the event loop before
    // launchctl has been accounted for. A blocking execSync would have already
    // finished by this point, with nothing left to await.
    expect(pending).toBeInstanceOf(Promise)
    expect(await pending).toBe(true)

    expect(vi.mocked(execFile)).toHaveBeenCalled()
    const [file, args] = vi.mocked(execFile).mock.calls[0]
    expect(file).toBe('launchctl')
    // Argv form, not a shell string: no interpolated command line to quote.
    expect(args).toEqual(['kickstart', '-k', expect.stringContaining(PLIST_LABEL)])
  })
})

// ─── Daemon readiness: kickstart retry + socket verification ─────────────────
//
// The relaunch-handoff regression: the quitting desktop instance boots the
// agent out, the new instance's kickstart races the teardown and fails with
// `spawnSync /bin/sh ETIMEDOUT`, the old code swallowed it with a log line,
// and the app then ran for minutes against a dead engine (30 restoring tabs
// each timing out). These tests fail on that code: it issued exactly ONE
// kickstart and ZERO socket probes.

describe('ensureEngineDaemon — daemon readiness', () => {
  // Small budgets so retry/verify paths run without real multi-second waits.
  const FAST = {
    kickstartTimeoutMs: 50,
    kickstartAttempts: 3,
    kickstartSettleMs: 1,
    socketWaitMs: 20,
    socketPollMs: 1,
  }

  function seedInstalledFs() {
    // Unchanged plist + matched binary: the non-destructive kickstart path,
    // isolating these tests to the kickstart/verify behavior.
    fakeFs[plistTemplatePath] = '<string>$HOME/.ion/bin/ion</string>'
    fakeFs[bundledBinaryPath] = 'identical-bytes'
    fakeFs['/Users/testuser/.ion/bin/ion'] = 'identical-bytes'
    fakeFs['/Users/testuser/Library/LaunchAgents/com.ion.engine.plist'] = '<string>/Users/testuser/.ion/bin/ion</string>'
  }

  it('retries kickstart when launchctl transiently fails (ETIMEDOUT regression)', async () => {
    seedInstalledFs()
    kickstartFailuresRemaining = 1

    await ensureEngineDaemon(FAST)

    // Old code: one attempt, failure swallowed. New code: the failed attempt
    // is followed by a retry that succeeds.
    const kickstarts = execSyncCalls.filter((c) => c.includes('launchctl kickstart'))
    expect(kickstarts.length).toBe(2)
    // Daemon reachable → no recovery round beyond the succeeded kickstart.
    expect(socketProbeCount).toBeGreaterThan(0)
  })

  it('verifies the daemon socket after kickstart, polling until it binds', async () => {
    seedInstalledFs()
    // Daemon takes a couple of poll intervals to bind after kickstart.
    socketProbeResults = [false, false, true]

    await ensureEngineDaemon(FAST)

    // Old code never probed the socket at all (zero probes).
    expect(socketProbeCount).toBe(3)
  })

  it('re-issues kickstart when the socket never binds, then surfaces the failure', async () => {
    seedInstalledFs()
    socketDefaultReachable = false

    await ensureEngineDaemon(FAST)

    // Initial round + recovery round.
    const kickstarts = execSyncCalls.filter((c) => c.includes('launchctl kickstart'))
    expect(kickstarts.length).toBe(2)
    // Both readiness waits actually probed.
    expect(socketProbeCount).toBeGreaterThanOrEqual(2)
    // The terminal failure is surfaced at error level, not swallowed.
    const { error } = await import('../logger')
    expect(vi.mocked(error)).toHaveBeenCalledWith(
      'bootstrap',
      expect.stringContaining('failed to come up'),
      expect.objectContaining({ socket: expect.stringContaining('engine.sock') }),
    )
  })
})
