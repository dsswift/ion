/**
 * Windows Scheduled Task EngineSupervisor: registers and drives this user's
 * "Ion Engine (<SID>)" task via schtasks.exe. Manifest contract C2.
 *
 * A Scheduled Task name is machine-global, so the name carries the account's
 * SID -- see LEGACY_TASK_NAME for what the shared name did on a host with two
 * signed-in users, and migrateLegacyTask for how one is retired.
 *
 * The task's <Exec> runs `ion.exe serve --supervised` (see engine child 03),
 * which hides its own console window so the task never shows any UI.
 */
import { execFile } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { log as _log } from './logger'
import { atomicWriteFileSync } from './utils/atomicWrite'
import { probeEngine, resolveEngineAddress } from './engine-address'
import type { EngineSupervisor, SupervisorOpts } from './engine-supervisor'
import { ENGINE_HOST_NAME } from './engine-binary-install'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('bootstrap', msg, fields)
}

/**
 * The task name every Ion before this one registered: one machine-scoped
 * name, shared by every account on the host.
 *
 * A Scheduled Task name is machine-global. Two users signing in to the same
 * Windows host therefore fought over one registration: whoever launched Ion
 * last overwrote the other's task, pointing its principal and its <Exec> at
 * their own account and their own %USERPROFILE%. The loser's engine stopped
 * being started at logon, and `schtasks /End` from either desktop stopped
 * whichever engine the surviving definition described. On an Azure Virtual
 * Desktop multi-session host that is not an edge case, it is the normal
 * state.
 *
 * Kept as a constant because it is still the name of the thing being
 * migrated away from -- see migrateLegacyTask.
 */
export const LEGACY_TASK_NAME = 'Ion Engine'

/**
 * The per-user task name.
 *
 * The SID is the identity because it is the only per-account value that is
 * unique on the machine and stable across a rename: a username is not unique
 * once a domain account and a local account share a short name, and it is
 * reusable after a delete-and-recreate. Task Scheduler treats a backslash as
 * a folder separator, so a name must contain none; a string SID is digits and
 * hyphens only, which is safe unescaped.
 *
 * The `Ion Engine (` prefix is what lets an administrator enumerate every
 * user's task on a host without knowing any SID -- the uninstall and
 * remediation paths in packaging/windows/ depend on it, so it is not a
 * cosmetic choice.
 */
export function taskNameForSid(sid: string): string {
  return `${LEGACY_TASK_NAME} (${sid})`
}

const TASK_TEMPLATE_FILENAME = 'ion-engine-task.xml'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Locate the task XML template. Checked in order:
 *   1. Packaged app: resources/engine/ion-engine-task.xml
 *   2. Dev monorepo: <repo>/packaging/windows/ion-engine-task.xml
 */
export function findTaskTemplate(): string | null {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'engine', TASK_TEMPLATE_FILENAME) : null,
    join(__dirname, '..', '..', '..', 'packaging', 'windows', TASK_TEMPLATE_FILENAME),
    join(__dirname, '..', '..', '..', '..', 'packaging', 'windows', TASK_TEMPLATE_FILENAME),
  ]
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return null
}

interface SchtasksResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Runs schtasks.exe with args. Never throws — a non-zero exit is a normal
 * outcome for several callers (e.g. /End on an already-stopped task), so the
 * exit code and stderr are returned for the caller to interpret. Every call
 * is logged.
 */
async function schtasks(args: string[], opts: SupervisorOpts): Promise<SchtasksResult> {
  return new Promise((resolve) => {
    execFile('schtasks.exe', args, { timeout: opts.commandTimeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
        ? ((err as unknown as { code: number }).code)
        : err ? 1 : 0
      log('engine_bootstrap: schtasks', { args, code, stderr: (stderr || '').slice(0, 500) })
      resolve({ code, stdout: stdout || '', stderr: stderr || '' })
    })
  })
}

/**
 * Runs schtasks.exe and returns its stdout decoded, or null when the command
 * failed. Used for /Query /XML, where the bytes matter and a non-zero exit
 * simply means the task is not registered.
 */
async function schtasksBuffer(args: string[], opts: SupervisorOpts): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'schtasks.exe',
      args,
      { timeout: opts.commandTimeoutMs, windowsHide: true, encoding: 'buffer' },
      (err, stdout) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf-8')
        log('engine_bootstrap: schtasks', { args, code: err ? 1 : 0, bytes: out.length })
        resolve(err ? null : decodeSchtasksOutput(out))
      },
    )
  })
}

/**
 * install renders the task XML template (substituting $ION_BIN and
 * $ION_HOME) and registers it with schtasks /Create /F. Returns true when
 * the rendered content actually changed, or the task was not yet
 * registered — either case means a caller-driven force-restart is
 * justified.
 */
/**
 * The account the task belongs to, as Task Scheduler names it.
 *
 * A LogonTrigger with no UserId fires for every account on the machine. That
 * is a machine-wide registration a standard user may not make, and schtasks
 * refuses it with "Access is denied" -- so the trigger has to name an account,
 * and scoping it to one account is what a per-user engine means anyway.
 *
 * The SID is used rather than a name because names are not dependable here.
 * %USERDOMAIN% is "WORKGROUP" on a standalone machine, which resolves to
 * nothing ("No mapping between account names and security IDs was done"), and
 * an Entra-joined device's interactive account does not match the local
 * profile name either. A SID is unambiguous everywhere and is what Task
 * Scheduler writes when it exports a task itself.
 */
async function currentUserSid(opts: SupervisorOpts): Promise<string> {
  const sid = await new Promise<string | null>((resolve) => {
    execFile(
      'whoami.exe',
      ['/user', '/fo', 'csv', '/nh'],
      { timeout: opts.commandTimeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null)
        resolve(/S-1-[\d-]+/.exec(stdout || '')?.[0] ?? null)
      },
    )
  })
  if (!sid) {
    // There used to be a username fallback here. It cannot be kept now that
    // the SID is the task's IDENTITY rather than only its principal: a
    // username is not unique on a host where a domain account and a local
    // account share a short name, so two users could still land on one task
    // name -- the exact collision this change removes, reached by the failure
    // path. Refusing is loud and recoverable; a shared registration is
    // neither.
    throw new Error(
      'Cannot read this user\'s Windows SID, so the Ion Engine task has no unambiguous per-user name. ' +
      'The engine will not register a task shared with other accounts on this machine.',
    )
  }
  log('engine_bootstrap: task identity resolved', { source: 'sid', sid })
  return sid
}

/**
 * This process's task name, resolved once.
 *
 * Memoised because every supervisor verb needs it and the SID cannot change
 * within a process. A failed resolution is NOT cached: the whoami call can
 * fail transiently (a timeout under load), and caching that would leave the
 * desktop unable to reach its engine for the rest of the session.
 */
let cachedTaskName: string | null = null

async function taskName(opts: SupervisorOpts): Promise<string> {
  if (cachedTaskName !== null) return cachedTaskName
  cachedTaskName = taskNameForSid(await currentUserSid(opts))
  return cachedTaskName
}

/** Test seam: clears the memoised task name so a test can vary the SID. */
export function _resetTaskNameCacheForTest(): void {
  cachedTaskName = null
}

/**
 * Read a schtasks stdout buffer as text.
 *
 * `schtasks /Query /XML` writes UTF-16LE when its output is redirected and
 * plain text when it is not, and the difference is invisible to a caller that
 * assumed one of them. Decoding by BOM, then by the NUL-byte signature of
 * UTF-16 text, then falling back to UTF-8, reads both correctly -- and a
 * misread here would silently fail the ownership check below, which is the
 * one branch that must not be guessed at.
 */
export function decodeSchtasksOutput(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  const sample = buf.subarray(0, Math.min(buf.length, 256))
  const nuls = sample.reduce((n, b) => (b === 0 ? n + 1 : n), 0)
  if (nuls > sample.length / 4) return buf.toString('utf16le')
  return buf.toString('utf-8')
}

/**
 * The account a task definition names as its principal, or null when the XML
 * carries no SID.
 *
 * Task Scheduler writes the principal's SID into <UserId> when the task was
 * registered with one, which is what every Ion release since the per-user
 * principal change has done. A definition with a username there instead
 * predates that and cannot be attributed to an account without a name
 * lookup, so it reads as null and is left alone.
 */
export function taskPrincipalSid(xml: string): string | null {
  const ids = [...xml.matchAll(/<UserId>\s*([^<]+?)\s*<\/UserId>/g)].map((m) => m[1])
  for (const id of ids) {
    if (/^S-1-[\d-]+$/.test(id)) return id
  }
  return null
}

/**
 * Remove the legacy machine-scoped "Ion Engine" task, but only when this user
 * can be shown to own it.
 *
 * Ownership is proved from the registered definition's own <UserId>, not from
 * whether the delete happens to succeed. A standard user's delete of another
 * account's task would usually fail with access denied -- but "usually" is
 * not a guarantee, and an administrator running Ion would not be stopped at
 * all. Deleting another user's task would strip their engine's logon trigger
 * and leave them with no engine at next sign-in, which is a worse outcome
 * than leaving a stale task behind.
 *
 * So: no task, nothing to do. A task whose principal is somebody else, or
 * whose principal cannot be read, is left in place and logged. Only a task
 * this SID is named in is removed.
 */
async function migrateLegacyTask(sid: string, opts: SupervisorOpts): Promise<void> {
  const xml = await schtasksBuffer(['/Query', '/TN', LEGACY_TASK_NAME, '/XML', 'ONE'], opts)
  if (xml === null) {
    log('engine_bootstrap: no legacy task to migrate', { task: LEGACY_TASK_NAME })
    return
  }
  const owner = taskPrincipalSid(xml)
  if (owner === null) {
    log('engine_bootstrap: legacy task left in place, its principal is not a SID', { task: LEGACY_TASK_NAME })
    return
  }
  if (owner !== sid) {
    log('engine_bootstrap: legacy task left in place, it belongs to another account', {
      task: LEGACY_TASK_NAME, owner_sid: owner, this_sid: sid,
    })
    return
  }
  const r = await schtasks(['/Delete', '/TN', LEGACY_TASK_NAME, '/F'], opts)
  if (r.code === 0) {
    log('engine_bootstrap: removed this user\'s legacy task', { task: LEGACY_TASK_NAME, owner_sid: owner })
  } else {
    log('engine_bootstrap: could not remove this user\'s legacy task', {
      task: LEGACY_TASK_NAME, code: r.code, stderr: r.stderr.slice(0, 300),
    })
  }
}

/**
 * Resolve what the task's <Exec> should run.
 *
 * Task Scheduler always allocates a console for a console-subsystem image,
 * and nothing the daemon does afterwards can hide it: where the default
 * terminal is Windows Terminal, the visible window belongs to
 * WindowsTerminal.exe while GetConsoleWindow() reaches only the
 * OpenConsole.exe pseudoconsole window. So the task runs the GUI-subsystem
 * host installed beside the engine, which never gets a console and starts
 * the engine with CREATE_NO_WINDOW.
 *
 * When the host is not on disk -- an install that predates it, or a dev tree
 * built before this step -- the task falls back to running the engine
 * directly. That is the old behaviour, console window included, and it is
 * logged at WARNING: a visible window is a defect, an engine that does not
 * start at all is worse.
 */
/**
 * Remove every XML comment from a task definition, leaving the declaration
 * and the elements. Exported for testing.
 */
export function stripXmlComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->\n?/g, '')
}

export function resolveTaskAction(binPath: string): { command: string; args: string } {
  const host = join(dirname(binPath), ENGINE_HOST_NAME)
  if (existsSync(host)) {
    return { command: host, args: `"${binPath}" serve --supervised` }
  }
  log('WARNING: engine host launcher missing, the engine will run with a visible console window', { expected: host })
  return { command: binPath, args: 'serve --supervised' }
}

async function install(binPath: string, opts: SupervisorOpts): Promise<boolean> {
  const templatePath = findTaskTemplate()
  if (!templatePath) {
    log('WARNING: task template not found, skipping task install')
    return false
  }

  const sid = await currentUserSid(opts)
  const name = taskNameForSid(sid)
  cachedTaskName = name
  // Before registering the per-user task, retire this user's shared one --
  // otherwise both exist, both hold a logon trigger, and two engines race for
  // the same address at every sign-in.
  await migrateLegacyTask(sid, opts)

  const ionHome = join(homedir(), '.ion')
  const action = resolveTaskAction(binPath)
  log('engine_bootstrap: task action resolved', { command: action.command, args: action.args })
  // The template's documentation block names the placeholders it documents,
  // and substitution is global, so a value that lands there is rewritten into
  // prose the operator never wanted and -- worse -- can break the file. XML
  // forbids "--" inside a comment, so rendering `serve --supervised` into the
  // sentence describing $ION_ARGS made the whole definition unparseable:
  // "(6,59)::ERROR: incorrect comment syntax". The comment is documentation
  // for whoever reads the repo file; the registered task has no use for it.
  // Stripping it before substitution removes the entire class of failure
  // rather than the one value that exposed it.
  const template = stripXmlComments(readFileSync(templatePath, 'utf-8'))
  const rendered = template
    .replaceAll('$ION_BIN', action.command)
    .replaceAll('$ION_ARGS', action.args)
    .replaceAll('$ION_HOME', ionHome)
    .replaceAll('$ION_USER', sid)

  // schtasks /XML parses the file as UTF-16 and will not switch encodings
  // partway through. A UTF-8 file fails at the declaration with
  // "(1,40)::ERROR: unable to switch the encoding", and adding a UTF-8 BOM
  // only moves the failure to "(1,2)::ERROR: incorrect document syntax".
  // The Task Scheduler's own export format is UTF-16LE with a BOM, which is
  // what the template's declaration already says, so that is what is written
  // and the declaration is left alone.
  const encoded = Buffer.from(`\ufeff${rendered}`, 'utf16le')

  const target = join(ionHome, 'ion-engine-task.xml')
  const alreadyRegistered = await isRegisteredWithOpts(opts)
  // Compare the decoded definition rather than the bytes, so the check stays
  // about whether the task changed and not about how it is encoded.
  const existing = existsSync(target) ? readFileSync(target, 'utf16le').replace(/^\ufeff/, '') : null
  const unchanged = existing === rendered && alreadyRegistered
  if (unchanged) {
    log('engine_bootstrap: task definition unchanged')
    return false
  }

  atomicWriteFileSync(target, encoded, 0o644)
  const r = await schtasks(['/Create', '/TN', name, '/XML', target, '/F'], opts)
  if (r.code !== 0) {
    throw new Error(`schtasks /Create failed (${r.code}): ${r.stderr}`)
  }
  log('engine_bootstrap: task registered', { task: name, path: target })
  return true
}

/**
 * start runs the task. force stops it first (so the restart actually
 * recycles the process rather than being a no-op under IgnoreNew).
 */
async function start(force: boolean, opts: SupervisorOpts): Promise<void> {
  if (force) await stop(opts)
  const r = await schtasks(['/Run', '/TN', await taskName(opts)], opts)
  if (r.code !== 0) {
    throw new Error(`schtasks /Run failed (${r.code}): ${r.stderr}`)
  }
}

/**
 * stop ends the task's running instance and waits until the engine no
 * longer accepts connections (proving the process actually exited, not
 * just that schtasks accepted the command). A non-zero /End exit is the
 * normal "already stopped" case, logged at DEBUG rather than treated as a
 * failure.
 */
async function stop(opts: SupervisorOpts): Promise<void> {
  const r = await schtasks(['/End', '/TN', await taskName(opts)], opts)
  if (r.code !== 0) {
    log('engine_bootstrap: schtasks /End non-zero (task likely already stopped)', { code: r.code })
  }

  const addr = resolveEngineAddress()
  const deadline = Date.now() + opts.stopWaitMs
  while (Date.now() < deadline) {
    if (!(await probeEngine(addr))) {
      log('engine_bootstrap: engine stopped accepting connections')
      return
    }
    await sleep(opts.stopPollMs)
  }
  log('engine_bootstrap: engine still reachable after stop wait budget')
}

async function isRegisteredWithOpts(opts: SupervisorOpts): Promise<boolean> {
  const r = await schtasks(['/Query', '/TN', await taskName(opts)], opts)
  return r.code === 0
}

export const schtasksSupervisor: EngineSupervisor = {
  name: 'schtasks',
  install,
  start,
  stop,
  isRegistered: () => isRegisteredWithOpts({ commandTimeoutMs: 10000, attempts: 1, settleMs: 0, stopWaitMs: 0, stopPollMs: 0 }),
}
