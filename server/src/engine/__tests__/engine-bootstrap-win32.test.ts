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
/** What Task Scheduler reports as this user's registered task definition. */
let registeredTaskXml = ''
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
    // `/Query /TN <task> /XML ONE` reads the registered definition: the
    // per-user task answers with registeredTaskXml, the legacy shared task
    // and every other command with nothing.
    const registered = args[0] === '/Query' && args.includes('/XML') && args[2] !== 'Ion Engine' ? registeredTaskXml : ''
    done?.(null, file === 'whoami.exe' ? '"testbox\\\\testuser","S-1-5-21-99-1001"\\r\\n' : registered, '')
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

// whoami.exe supplies the task principal SID used by every registration.
// Partial: only homedir and userInfo are under test control. A total
// replacement broke once secretStore (reached transitively through server
// config) began reading os.hostname at module load.
vi.mock('os', async (importOriginal) => ({ ...(await importOriginal<typeof import('os')>()), ...{
  homedir: () => '/Users/testuser',
  userInfo: () => ({ username: 'testuser' }),
} }))

vi.mock('../../utils/atomicWrite', async (importOriginal) => ({ ...(await importOriginal()), ...{
  atomicWriteFileSync: vi.fn((p: string, content: string) => {
    writtenFiles[p] = content
    fakeFs[p] = content
  }),
} }))

// Without this the real logger runs inside the test worker: it writes to the
// log file and, where `fs` is mocked, fails on an export the mock does not
// provide.
vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

const originalPlatform = process.platform
let savedIonDataDir: string | undefined

beforeEach(() => {
  execOrder.length = 0
  registeredTaskXml = ''
  copiedFiles.length = 0
  renamedFiles.length = 0
  writtenFiles = {}
  fakeFs = {}
  socketProbeResults = []
  socketDefaultReachable = true
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  // dataDir() (`paths.ts`) checks ION_DATA_DIR before falling back to
  // homedir(), and the mocked os.homedir() below does not reach its
  // already-resolved binding — so without this, dataDir() resolves to the
  // real vitest-home fixture instead of HOME/.ion, the rendered task XML's
  // $ION_HOME substitution mismatches the fixture built from ionHomePath(),
  // and the definition looks "changed" on every run, forcing an unwanted
  // /End even on a genuine hash match.
  savedIonDataDir = process.env.ION_DATA_DIR
  process.env.ION_DATA_DIR = path.join('/Users/testuser', '.ion')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  if (savedIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = savedIonDataDir
})

import { ensureEngineDaemon } from '../engine-bootstrap'

// The dev-monorepo candidates the supervisor probes, from the repository root.
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..')
const taskTemplatePath = path.join(repoRoot, 'desktop', 'packaging-windows', 'ion-engine-task.xml')
const bundledBinaryWin32Path = path.join(repoRoot, 'engine', 'bin', 'ion.exe')

// Matches the mocked os.homedir() below. Production builds destBinary,
// ionHome, and the registered task-xml path via path.join(home, ...), which
// resolves with NATIVE separators (the real host's path implementation is
// selected at module-load time and does not follow the process.platform
// override in beforeEach). A hardcoded forward-slash literal here silently
// stops matching the join()-built keys production actually reads/writes on
// a win32 CI runner.
const HOME = '/Users/testuser'
const destBinaryWin32Path = () => path.join(HOME, '.ion', 'bin', 'ion.exe')
const ionHomePath = () => path.join(HOME, '.ion')
const taskXmlDestPath = () => path.join(ionHomePath(), 'ion-engine-task.xml')

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
    const destBinary = destBinaryWin32Path()
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
    const destBinary = destBinaryWin32Path()
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
    const destBinary = destBinaryWin32Path()
    fakeFs[destBinary] = 'identical-bytes'
    // Task already registered with the exact rendered content: Task
    // Scheduler's own copy is what the supervisor compares against.
    const rendered = fakeFs[taskTemplatePath].replaceAll('$ION_BIN', destBinary).replaceAll('$ION_HOME', ionHomePath())
    fakeFs[taskXmlDestPath()] = rendered
    registeredTaskXml = rendered

    await ensureEngineDaemon(FAST)

    expect(copiedFiles.length).toBe(0)
    expect(execOrder.some((e) => e.cmd.includes('/End'))).toBe(false)
    expect(execOrder.some((e) => e.cmd.includes('/Query'))).toBe(true)
    expect(execOrder.some((e) => e.cmd.includes('/Run'))).toBe(true)
  })

  // The engine reads engine.json once at start. A config write this launch
  // must recycle the daemon inside this one start: a separate restart after
  // it stops the engine just brought up, and a desktop killed between that
  // /End and its /Run leaves the task stopped.
  it('on a config change: forces the start, so /End comes before the first /Run', async () => {
    fakeFs[bundledBinaryWin32Path] = 'identical-bytes'
    const destBinary = destBinaryWin32Path()
    fakeFs[destBinary] = 'identical-bytes'
    const rendered = fakeFs[taskTemplatePath].replaceAll('$ION_BIN', destBinary).replaceAll('$ION_HOME', ionHomePath())
    fakeFs[taskXmlDestPath()] = rendered
    registeredTaskXml = rendered

    await ensureEngineDaemon(FAST, { configChanged: true })

    const taskVerbs = execOrder.map((e) => e.cmd).filter((c) => c.includes('/End') || c.includes('/Run'))
    expect(taskVerbs[0]).toContain('/End')
    expect(taskVerbs[1]).toContain('/Run')
  })
})
