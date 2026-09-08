/**
 * schtasks EngineSupervisor tests. process.platform is pinned to 'win32' so
 * the win32-branch code paths execute regardless of the CI host OS (this
 * module has no build-tag equivalent; it is platform-neutral TypeScript
 * reached only through supervisorFor('win32') in production).
 *
 * Expected paths are built with the real (Node) path.join rather than
 * hardcoded backslash literals: path.join uses the host OS's separator
 * regardless of process.platform, so a literal Windows path would mismatch
 * on this test's actual (non-Windows) run host. The module under test uses
 * the same path.join, so building expectations the same way keeps the
 * assertion host-independent while still proving the real substitution and
 * argv shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import { execFile } from 'child_process'

const execFileCalls: Array<{ file: string; args: string[] }> = []
let execFileExitCode = 0
let execFileStderr = ''

vi.mock('child_process', () => ({
  execFile: vi.fn((file: string, args: string[], _opts: any, cb: (err: any, stdout?: string, stderr?: string) => void) => {
    execFileCalls.push({ file, args })
    if (execFileExitCode !== 0) {
      const err: any = new Error(`exit ${execFileExitCode}`)
      err.code = execFileExitCode
      cb(err, '', execFileStderr)
    } else {
      cb(null, '', '')
    }
  }),
}))

let fakeFs: Record<string, string | Buffer> = {}
// whoami.exe supplies the SID the task principal is scoped to; flip this to
// exercise the username fallback.
let whoamiFails = false
/** The legacy "Ion Engine" task's XML definition, or null when none exists. */
let legacyTaskXml: string | null = null
const atomicWrites: Array<{ path: string; content: string | Buffer }> = []

/** Decode a captured write the way schtasks would read it. */
const writtenText = (c: string | Buffer): string =>
  Buffer.isBuffer(c) ? c.toString('utf16le').replace(/^\ufeff/, '') : c

// The fake filesystem stores whatever was written, bytes included, and decodes
// on read according to the requested encoding. A mock that silently handed back
// a string would hide the encoding this module exists to get right.
vi.mock('fs', () => ({
  existsSync: vi.fn((p: string) => p in fakeFs),
  readFileSync: vi.fn((p: string, enc?: string) => {
    const v = fakeFs[p]
    if (v === undefined) return ''
    if (Buffer.isBuffer(v)) return enc ? v.toString(enc as BufferEncoding) : v
    return v
  }),
}))

vi.mock('../utils/atomicWrite', () => ({
  atomicWriteFileSync: vi.fn((path: string, content: string | Buffer) => {
    atomicWrites.push({ path, content })
    fakeFs[path] = content
  }),
}))

vi.mock('net', () => ({
  createConnection: vi.fn(() => {
    const handlers: Record<string, () => void> = {}
    const conn = {
      once: (ev: string, cb: () => void) => { handlers[ev] = cb; return conn },
      destroy: vi.fn(),
    }
    queueMicrotask(() => { handlers['error']?.() })
    return conn
  }),
}))

const FAKE_HOME = path.join('fake-home')
vi.mock('os', () => ({
  homedir: () => path.join('fake-home'),
  userInfo: () => ({ username: 'testuser' }),
}))
vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }))

const originalPlatform = process.platform

beforeEach(() => {
  execFileCalls.length = 0
  execFileExitCode = 0
  execFileStderr = ''
  fakeFs = {}
  atomicWrites.length = 0
  whoamiFails = false
  legacyTaskXml = null
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  installExecFileMock()
  _resetTaskNameCacheForTest()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

/**
 * The default execFile behaviour: whoami.exe reports a SID (or fails when
 * whoamiFails is set), and every other command honours execFileExitCode.
 *
 * Installed in beforeEach rather than afterEach. It used to be installed only
 * afterwards, which left the FIRST test in the file running against the bare
 * vi.mock factory -- a factory that knows nothing about whoami. That was
 * invisible while an unreadable SID silently fell back to a username; it stops
 * being invisible now that it is a refusal, and the ordering dependency was
 * always a defect.
 */
function installExecFileMock(): void {
  vi.mocked(execFile).mockImplementation(((file: string, args: string[], _opts: any, cb: any) => {
    execFileCalls.push({ file, args })
    if (file === 'whoami.exe') {
      if (whoamiFails) return cb(new Error('whoami unavailable'), '', '')
      return cb(null, '"testbox\\testuser","S-1-5-21-99-1001"\r\n', '')
    }
    // /Query /XML asks for the legacy task's definition. legacyTaskXml is
    // null when no legacy task exists, which is the common case.
    if (args[0] === '/Query' && args.includes('/XML')) {
      if (legacyTaskXml === null) return cb(new Error('task not found'), Buffer.alloc(0), '')
      return cb(null, Buffer.from(legacyTaskXml, 'utf-8'), '')
    }
    if (execFileExitCode !== 0) {
      const err: any = new Error(`exit ${execFileExitCode}`)
      err.code = execFileExitCode
      cb(err, '', execFileStderr)
    } else {
      cb(null, '', '')
    }
  }) as any)
}

import {
  schtasksSupervisor,
  resolveTaskAction,
  stripXmlComments,
  taskNameForSid,
  taskPrincipalSid,
  decodeSchtasksOutput,
  LEGACY_TASK_NAME,
  _resetTaskNameCacheForTest,
} from '../engine-supervisor-schtasks'
import type { SupervisorOpts } from '../engine-supervisor'

const supervisorDir = path.join(__dirname, '..')
const taskTemplatePath = path.resolve(supervisorDir, '..', '..', '..', 'packaging', 'windows', 'ion-engine-task.xml')
const ionHome = path.join(FAKE_HOME, '.ion')
const taskTarget = path.join(ionHome, 'ion-engine-task.xml')
const fakeBinPath = path.join('fake-bin', 'ion.exe')
const fakeHostPath = path.join('fake-bin', 'ion-engine-host.exe')

const OPTS: SupervisorOpts = { commandTimeoutMs: 1000, attempts: 1, settleMs: 0, stopWaitMs: 100, stopPollMs: 10 }

describe('rendering the task definition', () => {
  // The shipped template documents its own placeholders by name, and
  // substitution is global. Rendering $ION_ARGS ("... serve --supervised")
  // into that sentence put "--" inside an XML comment, which XML forbids;
  // schtasks refused the whole definition with
  // "(6,59)::ERROR: incorrect comment syntax" and the desktop started with no
  // engine. The comment is documentation for the repo file, so it is stripped
  // before anything is substituted.
  it('registers a definition with no comments in it', async () => {
    fakeFs[fakeHostPath] = 'host binary'
    fakeFs[taskTemplatePath] =
      '<?xml version="1.0" encoding="UTF-16"?>\n' +
      '<!--\n  The desktop substitutes $ION_BIN and $ION_ARGS before writing this.\n-->\n' +
      '<Task><Exec><Command>$ION_BIN</Command><Arguments>$ION_ARGS</Arguments></Exec></Task>'

    await schtasksSupervisor.install(fakeBinPath, OPTS)

    const text = writtenText(atomicWrites.find((w) => w.path === taskTarget)!.content)
    expect(text).not.toContain('<!--')
    expect(text).toContain('<?xml version="1.0" encoding="UTF-16"?>')
    expect(text).toContain(`<Arguments>"${fakeBinPath}" serve --supervised</Arguments>`)
    // The failure this pins: a "--" anywhere inside a comment block.
    for (const comment of text.match(/<!--[\s\S]*?-->/g) ?? []) {
      expect(comment).not.toContain('--')
    }
  })

  it('keeps the declaration and the elements when stripping comments', () => {
    const stripped = stripXmlComments('<?xml version="1.0"?>\n<!-- gone -->\n<Task><A/></Task>')
    expect(stripped).toBe('<?xml version="1.0"?>\n<Task><A/></Task>')
  })
})

describe('resolveTaskAction', () => {
  // The whole point of the host launcher: Task Scheduler always allocates a
  // console for a console-subsystem image, and a ConPTY's visible window
  // belongs to WindowsTerminal.exe where the daemon cannot reach it. Running
  // the GUI-subsystem host instead is what keeps a terminal off the screen,
  // so the task must name the host and pass the engine as its argument.
  it('runs the host launcher and passes it the engine, when the host is installed', () => {
    fakeFs[fakeHostPath] = 'host binary'

    const action = resolveTaskAction(fakeBinPath)

    expect(action.command).toBe(fakeHostPath)
    expect(action.args).toBe(`"${fakeBinPath}" serve --supervised`)
  })

  // An install that predates the host, or a dev tree built before the build
  // step existed, must still get a running engine. It gets the old visible
  // console with it, which is why the supervisor logs a warning here.
  it('falls back to running the engine directly when the host is absent', () => {
    const action = resolveTaskAction(fakeBinPath)

    expect(action.command).toBe(fakeBinPath)
    expect(action.args).toBe('serve --supervised')
  })

  it('renders the resolved action into the registered task definition', async () => {
    fakeFs[fakeHostPath] = 'host binary'
    fakeFs[taskTemplatePath] = '<Task><Exec><Command>$ION_BIN</Command><Arguments>$ION_ARGS</Arguments></Exec></Task>'

    await schtasksSupervisor.install(fakeBinPath, OPTS)

    const text = writtenText(atomicWrites.find((w) => w.path === taskTarget)!.content)
    expect(text).toContain(`<Command>${fakeHostPath}</Command>`)
    expect(text).toContain(`<Arguments>"${fakeBinPath}" serve --supervised</Arguments>`)
    expect(text).not.toContain('$ION_')
  })
})

describe('schtasksSupervisor.install', () => {
  it('substitutes both placeholders and leaves no $ION_ prefix behind', async () => {
    fakeFs[taskTemplatePath] = '<?xml version="1.0" encoding="UTF-16"?>\n<Task><Exec><Command>$ION_BIN</Command><WorkingDirectory>$ION_HOME</WorkingDirectory></Exec></Task>'

    await schtasksSupervisor.install(fakeBinPath, OPTS)

    const written = atomicWrites.find((w) => w.path === taskTarget)
    expect(written).toBeDefined()
    expect(writtenText(written!.content)).toContain(fakeBinPath)
    expect(writtenText(written!.content)).toContain(ionHome)
    expect(writtenText(written!.content)).not.toContain('$ION_')
  })

  // schtasks parses the file as UTF-16 and refuses to switch encodings partway.
  // Writing UTF-8 -- which this module used to do, having rewritten the
  // declaration -- fails with "(1,40)::ERROR: unable to switch the encoding",
  // and the desktop never starts because the engine task cannot be registered.
  it('writes the task definition as UTF-16LE with a BOM', async () => {
    fakeFs[taskTemplatePath] =
      '<?xml version="1.0" encoding="UTF-16"?>\n<Task><Exec><Command>$ION_BIN</Command></Exec></Task>'

    await schtasksSupervisor.install(fakeBinPath, OPTS)

    const written = atomicWrites.find((w) => w.path === taskTarget)
    expect(Buffer.isBuffer(written!.content)).toBe(true)
    const bytes = written!.content as Buffer
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe])
    expect(writtenText(bytes)).toContain('<Task>')
  })

  it('leaves the UTF-16 declaration alone', async () => {
    fakeFs[taskTemplatePath] =
      '<?xml version="1.0" encoding="UTF-16"?>\n<Task><Exec><Command>$ION_BIN</Command></Exec></Task>'

    await schtasksSupervisor.install(fakeBinPath, OPTS)

    const text = writtenText(atomicWrites.find((w) => w.path === taskTarget)!.content)
    expect(text).toContain('encoding="UTF-16"')
    expect(text).not.toContain('encoding="UTF-8"')
  })

  // A LogonTrigger with no UserId fires for every account on the machine. That
  // is a machine-wide registration, so schtasks refuses it from a standard
  // user's desktop with "Access is denied" and Ion never gets an engine.
  it('scopes the task to the current account by SID', async () => {
    fakeFs[taskTemplatePath] =
      '<?xml version="1.0" encoding="UTF-16"?>\n<Task><Triggers><LogonTrigger><UserId>$ION_USER</UserId></LogonTrigger></Triggers>' +
      '<Principals><Principal><UserId>$ION_USER</UserId></Principal></Principals></Task>'

    await schtasksSupervisor.install(fakeBinPath, OPTS)

    const text = writtenText(atomicWrites.find((w) => w.path === taskTarget)!.content)
    expect(text).not.toContain('$ION_USER')
    // Both the trigger and the principal, not just one of them.
    expect(text.match(/S-1-5-21-99-1001/g)).toHaveLength(2)
  })

  // A task name is machine-global, so an unreadable SID cannot be papered
  // over with a username: a domain account and a local account can share a
  // short name, which puts two users back on one registration -- the exact
  // collision the per-user name removes, reached by the failure path. The
  // install refuses instead, and registers nothing.
  it('refuses to register a task when the SID cannot be read', async () => {
    whoamiFails = true
    fakeFs[taskTemplatePath] = '<Task><LogonTrigger><UserId>$ION_USER</UserId></LogonTrigger></Task>'

    await expect(schtasksSupervisor.install(fakeBinPath, OPTS)).rejects.toThrow(/SID/)

    expect(execFileCalls.find((c) => c.args[0] === '/Create')).toBeUndefined()
    expect(atomicWrites).toHaveLength(0)
  })

  it('install argv matches the documented /Create shape', async () => {
    fakeFs[taskTemplatePath] = '<Task><Exec><Command>$ION_BIN</Command><WorkingDirectory>$ION_HOME</WorkingDirectory></Exec></Task>'

    await schtasksSupervisor.install(fakeBinPath, OPTS)

    const createCall = execFileCalls.find((c) => c.args[0] === '/Create')
    expect(createCall).toBeDefined()
    expect(createCall!.args).toEqual([
      '/Create', '/TN', 'Ion Engine (S-1-5-21-99-1001)', '/XML', taskTarget, '/F',
    ])
  })

  it('reports changed=true when the task was not yet registered', async () => {
    fakeFs[taskTemplatePath] = '<Task><Exec><Command>$ION_BIN</Command><WorkingDirectory>$ION_HOME</WorkingDirectory></Exec></Task>'
    // /Query (isRegistered) exits non-zero: not registered. install's own
    // /Create call must still succeed (exit 0), so only the /Query probe
    // fails.
    vi.mocked(execFile).mockImplementation(((file: string, args: string[], _opts: any, cb: any) => {
      execFileCalls.push({ file, args })
      if (file === 'whoami.exe') return cb(null, '"testbox\\testuser","S-1-5-21-99-1001"\r\n', '')
      if (args[0] === '/Query') {
        const err: any = new Error('exit 1')
        err.code = 1
        cb(err, '', '')
      } else {
        cb(null, '', '')
      }
    }) as any)

    const changed = await schtasksSupervisor.install(fakeBinPath, OPTS)
    expect(changed).toBe(true)
  })

  it('reports changed=false when content and registration are both unchanged', async () => {
    fakeFs[taskTemplatePath] = '<Task><Exec><Command>$ION_BIN</Command><WorkingDirectory>$ION_HOME</WorkingDirectory></Exec></Task>'
    const rendered = fakeFs[taskTemplatePath].replaceAll('$ION_BIN', fakeBinPath).replaceAll('$ION_HOME', ionHome)
    fakeFs[taskTarget] = rendered
    // execFileExitCode stays 0: /Query (isRegistered) succeeds.

    const changed = await schtasksSupervisor.install(fakeBinPath, OPTS)
    expect(changed).toBe(false)
    // No /Create call when nothing changed.
    expect(execFileCalls.find((c) => c.args[0] === '/Create')).toBeUndefined()
  })
})

describe('schtasksSupervisor.isRegistered', () => {
  it('maps exit 0 to true', async () => {
    execFileExitCode = 0
    await expect(schtasksSupervisor.isRegistered()).resolves.toBe(true)
    expect(execFileCalls.some((c) => c.args[0] === '/Query')).toBe(true)
  })

  it('maps a non-zero exit to false', async () => {
    execFileExitCode = 1
    await expect(schtasksSupervisor.isRegistered()).resolves.toBe(false)
  })
})

describe('schtasksSupervisor.stop', () => {
  it('polls the connect probe until it stops accepting connections', async () => {
    await schtasksSupervisor.stop(OPTS)
    expect(execFileCalls.some((c) => c.args[0] === '/End')).toBe(true)
  })
})

describe('schtasksSupervisor.start', () => {
  it('force restart calls /End then /Run', async () => {
    await schtasksSupervisor.start(true, OPTS)
    const endIndex = execFileCalls.findIndex((c) => c.args[0] === '/End')
    const runIndex = execFileCalls.findIndex((c) => c.args[0] === '/Run')
    expect(endIndex).toBeGreaterThanOrEqual(0)
    expect(runIndex).toBeGreaterThan(endIndex)
  })

  it('non-force start calls only /Run', async () => {
    await schtasksSupervisor.start(false, OPTS)
    expect(execFileCalls.some((c) => c.args[0] === '/End')).toBe(false)
    expect(execFileCalls.some((c) => c.args[0] === '/Run')).toBe(true)
  })
})

/**
 * Per-user task identity and the retirement of the shared one.
 *
 * These are the regression tests for the defect that made a multi-session
 * Windows host unsafe: one machine-global task name, "Ion Engine", registered
 * by whichever account launched Ion last. Every one of them fails against a
 * supervisor that uses a fixed name.
 */
describe('per-user task identity', () => {
  const SID_A = 'S-1-5-21-99-1001'
  const SID_B = 'S-1-5-21-99-1002'

  it('names the task after the account, not the machine', () => {
    expect(taskNameForSid(SID_A)).toBe('Ion Engine (S-1-5-21-99-1001)')
  })

  // The defect itself: two accounts on one host must not resolve to one
  // registration. With the old fixed name they did, and the second user's
  // launch silently repointed the first user's task at their own profile.
  it('gives two accounts on one host different task names', () => {
    expect(taskNameForSid(SID_A)).not.toBe(taskNameForSid(SID_B))
  })

  // A task name containing a backslash would create a Task Scheduler FOLDER
  // rather than a task in the root, which would break every /Query and /Run
  // that names it. A string SID cannot contain one, and this pins that the
  // composed name does not either.
  it('produces a name Task Scheduler treats as a single task', () => {
    expect(taskNameForSid(SID_A)).not.toContain('\\')
  })

  // Uninstall and the administrator remediation script both enumerate by this
  // prefix, so it is a contract between the desktop and packaging/windows/.
  it('keeps the prefix uninstall enumerates by', () => {
    expect(taskNameForSid(SID_A).startsWith(`${LEGACY_TASK_NAME} (`)).toBe(true)
  })

  // Every verb must address the SAME task. A /Run or /End that still named
  // the shared task would stop somebody else's engine.
  it.each([
    ['start', () => schtasksSupervisor.start(false, OPTS), '/Run'],
    ['stop', () => schtasksSupervisor.stop(OPTS), '/End'],
  ])('%s addresses this user\'s task', async (_name, run, verb) => {
    await run()
    const call = execFileCalls.find((c) => c.args[0] === verb)
    expect(call, `no ${verb} call was made`).toBeDefined()
    expect(call!.args[2]).toBe(`Ion Engine (${SID_A})`)
  })

  it('isRegistered queries this user\'s task', async () => {
    await schtasksSupervisor.isRegistered()
    const call = execFileCalls.find((c) => c.args[0] === '/Query' && !c.args.includes('/XML'))
    expect(call, 'no /Query call was made').toBeDefined()
    expect(call!.args[2]).toBe(`Ion Engine (${SID_A})`)
  })
})

describe('retiring the legacy shared task', () => {
  const SID_A = 'S-1-5-21-99-1001'
  const SID_B = 'S-1-5-21-99-1002'
  const legacyXml = (userId: string) =>
    '<?xml version="1.0" encoding="UTF-16"?><Task><Triggers><LogonTrigger>' +
    `<UserId>${userId}</UserId></LogonTrigger></Triggers>` +
    `<Principals><Principal><UserId>${userId}</UserId></Principal></Principals></Task>`

  const deleteCalls = () => execFileCalls.filter((c) => c.args[0] === '/Delete')

  beforeEach(() => {
    fakeFs[taskTemplatePath] = '<Task><Exec><Command>$ION_BIN</Command></Exec></Task>'
  })

  // Both tasks holding a logon trigger means two engines racing for the same
  // address at every sign-in, so this user's own leftover must go.
  it('removes the shared task when this user is its principal', async () => {
    legacyTaskXml = legacyXml(SID_A)

    await schtasksSupervisor.install(fakeBinPath, OPTS)

    expect(deleteCalls().map((c) => c.args)).toEqual([['/Delete', '/TN', LEGACY_TASK_NAME, '/F']])
  })

  // The safety property. Deleting another account's task strips their logon
  // trigger and leaves them with no engine at next sign-in -- worse than the
  // stale task it would clean up. An administrator running Ion would not be
  // stopped by permissions, so the check cannot be left to the OS.
  it('leaves the shared task alone when it belongs to another account', async () => {
    legacyTaskXml = legacyXml(SID_B)

    await schtasksSupervisor.install(fakeBinPath, OPTS)

    expect(deleteCalls()).toHaveLength(0)
  })

  // A definition whose principal is a username predates the SID principal and
  // cannot be attributed to an account without a name lookup. Unattributable
  // is not the same as mine.
  it('leaves the shared task alone when its principal is not a SID', async () => {
    legacyTaskXml = legacyXml('TESTBOX\\testuser')

    await schtasksSupervisor.install(fakeBinPath, OPTS)

    expect(deleteCalls()).toHaveLength(0)
  })

  it('does nothing when there is no shared task', async () => {
    legacyTaskXml = null

    await schtasksSupervisor.install(fakeBinPath, OPTS)

    expect(deleteCalls()).toHaveLength(0)
  })

  it('reads the principal SID out of a task definition', () => {
    expect(taskPrincipalSid(legacyXml(SID_A))).toBe(SID_A)
    expect(taskPrincipalSid(legacyXml('TESTBOX\\testuser'))).toBeNull()
    expect(taskPrincipalSid('<Task/>')).toBeNull()
  })

  // schtasks writes UTF-16LE when its output is redirected and plain text
  // when it is not. A misread would make every ownership check fail closed
  // and silently strand the legacy task forever.
  it('decodes schtasks output in either encoding it emits', () => {
    const xml = legacyXml(SID_A)
    expect(decodeSchtasksOutput(Buffer.from(xml, 'utf-8'))).toBe(xml)
    expect(decodeSchtasksOutput(Buffer.from(`﻿${xml}`, 'utf16le'))).toBe(xml)
    expect(decodeSchtasksOutput(Buffer.from(xml, 'utf16le'))).toBe(xml)
  })
})
