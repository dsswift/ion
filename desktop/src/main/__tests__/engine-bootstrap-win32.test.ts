/**
 * ensureEngineDaemon win32 dispatch ordering tests, split from
 * engine-bootstrap.test.ts (file-size cap). Pins the schtasks supervisor
 * ordering contract: on a binary hash mismatch, the task is stopped BEFORE
 * the copy (a running .exe cannot be overwritten on Windows), then
 * install-assets, then the task is (re)created, then run. On a hash match
 * the copy and stop are both skipped and the flow goes straight to
 * ensure-registered + run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'

const execOrder: Array<{ kind: 'execFile' | 'execFileSync'; cmd: string }> = []
const copiedFiles: Array<{ src: string; dst: string }> = []
const renamedFiles: Array<{ src: string; dst: string }> = []
let writtenFiles: Record<string, string> = {}
let fakeFs: Record<string, string> = {}
let socketProbeResults: boolean[] = []
let socketDefaultReachable = true

vi.mock('net', () => ({
  createConnection: vi.fn(() => {
    const reachable = socketProbeResults.length > 0 ? socketProbeResults.shift()! : socketDefaultReachable
    const handlers: Record<string, () => void> = {}
    const conn = {
      once: (ev: string, cb: () => void) => { handlers[ev] = cb; return conn },
      destroy: vi.fn(),
    }
    queueMicrotask(() => { handlers[reachable ? 'connect' : 'error']?.() })
    return conn
  }),
}))

vi.mock('child_process', () => ({
  execFile: vi.fn((file: string, args: string[], _opts: any, cb?: (err: Error | null, stdout?: string, stderr?: string) => void) => {
    const cmd = [file, ...args].join(' ')
    execOrder.push({ kind: 'execFile', cmd })
    const done = typeof _opts === 'function' ? (_opts as typeof cb) : cb
    done?.(null, '', '')
  }),
  execFileSync: vi.fn((file: string, args: string[]) => {
    execOrder.push({ kind: 'execFileSync', cmd: [file, ...args].join(' ') })
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

// userInfo backs the task principal's username fallback, which install()
// reaches on every registration. A mock without it throws before the
// assertions below ever run.
vi.mock('os', () => ({ homedir: () => '/Users/testuser', userInfo: () => ({ username: 'testuser' }) }))

vi.mock('../utils/atomicWrite', () => ({
  atomicWriteFileSync: vi.fn((p: string, content: string) => {
    writtenFiles[p] = content
    fakeFs[p] = content
  }),
}))

vi.mock('../logger', () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }))

const originalPlatform = process.platform

beforeEach(() => {
  execOrder.length = 0
  copiedFiles.length = 0
  renamedFiles.length = 0
  writtenFiles = {}
  fakeFs = {}
  socketProbeResults = []
  socketDefaultReachable = true
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

import { ensureEngineDaemon } from '../engine-bootstrap'

const bootstrapDir = path.join(__dirname, '..')
const taskTemplatePath = path.resolve(bootstrapDir, '..', '..', '..', 'packaging', 'windows', 'ion-engine-task.xml')
const bundledBinaryWin32Path = path.resolve(bootstrapDir, '..', '..', '..', 'engine', 'bin', 'ion.exe')

const FAST = {
  kickstartTimeoutMs: 50,
  kickstartAttempts: 3,
  kickstartSettleMs: 1,
  socketWaitMs: 20,
  socketPollMs: 1,
}

describe('ensureEngineDaemon — win32 dispatch', () => {
  beforeEach(() => {
    fakeFs[taskTemplatePath] = '<Task><Exec><Command>$ION_BIN</Command><WorkingDirectory>$ION_HOME</WorkingDirectory></Exec></Task>'
  })

  it('on hash mismatch: stops the task, copies, runs install-assets, creates the task, then runs', async () => {
    fakeFs[bundledBinaryWin32Path] = 'bundled-binary-bytes'
    const destBinary = '/Users/testuser/.ion/bin/ion.exe'
    fakeFs[destBinary] = 'old-binary-bytes'

    await ensureEngineDaemon(FAST)

    const order = execOrder.map((e) => e.cmd)
    const endIndex = order.findIndex((c) => c.includes('/End'))
    const installAssetsIndex = execOrder.findIndex((e) => e.kind === 'execFileSync' && e.cmd.includes('install-assets'))
    const createIndex = order.findIndex((c) => c.includes('/Create'))
    const runIndex = order.findIndex((c) => c.includes('/Run'))

    expect(endIndex).toBeGreaterThanOrEqual(0)
    expect(installAssetsIndex).toBeGreaterThan(endIndex)
    expect(createIndex).toBeGreaterThan(installAssetsIndex)
    expect(runIndex).toBeGreaterThan(createIndex)

    // The copy actually happened (stop-before-copy proven by the /End
    // preceding it in the order above).
    expect(copiedFiles.length).toBe(1)
    expect(fakeFs[destBinary]).toBe('bundled-binary-bytes')
  })

  // What makes a new install take effect at all. The engine reads engine.json
  // and its own binary exactly once at process start, so a fresh binary that
  // is merely copied to disk changes nothing until the daemon is recycled --
  // an MDM-pushed upgrade would leave every device running the old engine
  // until its next sign-in. A forced start is /End followed by /Run; an
  // unforced one is /Run alone against a task that is already running, which
  // IgnoreNew makes a no-op.
  it('on hash mismatch: forces the restart so the new binary is what runs', async () => {
    fakeFs[bundledBinaryWin32Path] = 'new-version-bytes'
    const destBinary = '/Users/testuser/.ion/bin/ion.exe'
    fakeFs[destBinary] = 'old-version-bytes'

    await ensureEngineDaemon(FAST)

    const order = execOrder.map((e) => e.cmd)
    const runIndex = order.findIndex((c) => c.includes('/Run'))
    // The /End that matters is the one guarding the start, after the task was
    // registered -- not the earlier one that unlocked the .exe for copying.
    const createIndex = order.findIndex((c) => c.includes('/Create'))
    const endBeforeRun = order.findIndex((c, i) => i > createIndex && c.includes('/End'))

    expect(runIndex).toBeGreaterThanOrEqual(0)
    expect(endBeforeRun).toBeGreaterThan(createIndex)
    expect(endBeforeRun).toBeLessThan(runIndex)
  })

  it('on hash match: skips the copy, ensures registration, then runs (no /End)', async () => {
    fakeFs[bundledBinaryWin32Path] = 'identical-bytes'
    const destBinary = '/Users/testuser/.ion/bin/ion.exe'
    fakeFs[destBinary] = 'identical-bytes'
    // Task already registered with the exact rendered content.
    const rendered = fakeFs[taskTemplatePath].replaceAll('$ION_BIN', destBinary).replaceAll('$ION_HOME', '/Users/testuser/.ion')
    fakeFs['/Users/testuser/.ion/ion-engine-task.xml'] = rendered

    await ensureEngineDaemon(FAST)

    expect(copiedFiles.length).toBe(0)
    expect(execOrder.some((e) => e.cmd.includes('/End'))).toBe(false)
    expect(execOrder.some((e) => e.cmd.includes('/Query'))).toBe(true)
    expect(execOrder.some((e) => e.cmd.includes('/Run'))).toBe(true)
  })
})
