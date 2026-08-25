import { userInfo } from 'os'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { log as _log, warn as _warn } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('launch-env', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('launch-env', msg, fields)
}

/**
 * The variable that makes Apple's /bin/zsh and /bin/bash refuse user startup files.
 *
 * macOS ships patched shells that turn on the PRIVILEGED option when this
 * variable is present in their environment. A privileged zsh reads only the
 * system files (/etc/zshenv, /etc/zprofile, /etc/zshrc, /etc/zlogin) and skips
 * every user file — ~/.zshenv, ~/.zprofile, ~/.zshrc, ~/.zlogin — even though
 * the shell runs as the real user with a real controlling terminal, and even
 * when it is started with -i and -l.
 *
 * `strings -a /bin/zsh | grep APPLE_PKGKIT_ESCALATING_ROOT` shows the marker
 * compiled into the shipped binary; /bin/bash carries the same marker.
 *
 * PkgKit sets it while a package's preinstall/postinstall scripts run. Any
 * process those scripts start inherits it, and so does every descendant, for
 * the whole life of that process tree. This is why a shell started from Ion
 * had no Starship prompt, no Zoxide, and none of the operator's PATH entries,
 * while the same command in Terminal.app was correct: the shell silently
 * skipped every user startup file.
 */
export const PRIVILEGE_ESCALATION_VAR = 'APPLE_PKGKIT_ESCALATING_ROOT'

/**
 * Variables that only a macOS package-installer script environment sets.
 *
 * Presence of any of these is proof that this process descends from an
 * Installer script rather than from a normal user launch. They are the
 * detection evidence, not a guess: nothing else on the system exports
 * `INSTALLER_PAYLOAD_DIR` or `INSTALL_PKG_SESSION_ID`.
 *
 * They are also actively harmful downstream. `DSTROOT` and `DSTVOLUME` retarget
 * build tooling, `PYTHONNOUSERSITE` disables the operator's Python user site
 * directory, and the INSTALLER_* temp paths point into a sandbox that Installer
 * deletes the moment the package finishes.
 */
export const INSTALLER_PROVENANCE_VARS = [
  PRIVILEGE_ESCALATION_VAR,
  'INSTALLER_TEMP',
  'INSTALLER_SECURE_TEMP',
  'INSTALLER_PAYLOAD_DIR',
  'SHARED_INSTALLER_TEMP',
  'INSTALL_PKG_SESSION_ID',
  'PACKAGE_PATH',
  'SCRIPT_NAME',
  'DSTROOT',
  'DSTVOLUME',
  'PYTHONNOUSERSITE',
  'LAUNCHCTL_ENV_REEXEC',
] as const

/** The account facts a sanitization plan is measured against. */
export interface LaunchEnvironmentAccount {
  username: string
  homedir: string
  shell: string
}

/** One corrected variable, kept with its original value for the log record. */
export interface LaunchEnvironmentCorrection {
  from: string | undefined
  to: string
  reason: string
}

/** What sanitization will do to an environment, before it does it. */
export interface LaunchEnvironmentPlan {
  /** True when installer-provenance markers prove an Installer-launched process. */
  contaminated: boolean
  /** True when the privilege marker is present, i.e. spawned shells skip user rc files. */
  privileged: boolean
  /** Installer markers actually found. */
  markers: string[]
  /** Variables to delete outright. */
  remove: string[]
  /** Variables to overwrite, with the value they had. */
  correct: Record<string, LaunchEnvironmentCorrection>
}

/** Whether a path names a directory that exists. Injected so the planner stays pure. */
export type DirectoryProbe = (path: string) => boolean

/**
 * Decide how to repair a launch environment.
 *
 * Pure: it reads the environment and the account, and returns the edits. The
 * caller applies them. This split is what lets a test assert the exact repair
 * for a captured installer environment without mutating the test runner's own
 * `process.env`.
 *
 * Identity repair (`USER`, `LOGNAME`, `HOME`, `SHELL`) is applied ONLY when
 * installer markers prove the environment came from an Installer script. An
 * uncontaminated process may legitimately run with `SHELL=/bin/sh` or a
 * `USER` its operator chose, and overwriting those from the account record
 * would be a guess. With the markers present it is not a guess: the values are
 * known to be the installer's (`LOGNAME=root` while the process runs as uid
 * 501 is the plain case).
 *
 * `TMPDIR` is repaired whenever it points at a directory that does not exist,
 * with or without markers. A dangling `TMPDIR` breaks every child that writes
 * a temporary file, and its non-existence is a fact rather than an inference.
 */
export function planLaunchEnvironmentSanitization(
  env: NodeJS.ProcessEnv,
  account: LaunchEnvironmentAccount,
  dirExists: DirectoryProbe,
): LaunchEnvironmentPlan {
  const markers = INSTALLER_PROVENANCE_VARS.filter((name) => env[name] !== undefined)
  const contaminated = markers.length > 0
  const privileged = env[PRIVILEGE_ESCALATION_VAR] !== undefined

  const remove: string[] = [...markers]
  const correct: Record<string, LaunchEnvironmentCorrection> = {}

  if (contaminated) {
    // The installer runs its scripts as root, so LOGNAME/USER name root while
    // the process itself runs as the console user. A shell that believes it is
    // root resolves the wrong home, the wrong history file, and the wrong
    // per-user tool state.
    if (account.username && env.USER !== account.username) {
      correct.USER = { from: env.USER, to: account.username, reason: 'installer-identity' }
    }
    if (account.username && env.LOGNAME !== account.username) {
      correct.LOGNAME = { from: env.LOGNAME, to: account.username, reason: 'installer-identity' }
    }
    if (account.homedir && env.HOME !== account.homedir) {
      correct.HOME = { from: env.HOME, to: account.homedir, reason: 'installer-identity' }
    }
    // Installer scripts run under /bin/sh and export it. Left in place it
    // becomes the default shell for anything that reads $SHELL.
    if (account.shell && env.SHELL !== account.shell) {
      correct.SHELL = { from: env.SHELL, to: account.shell, reason: 'installer-identity' }
    }
    // PWD names the package sandbox, which Installer deletes when it finishes.
    if (env.PWD && !dirExists(env.PWD)) {
      remove.push('PWD')
    }
  }

  const tmpdir = env.TMPDIR
  if (tmpdir && !dirExists(tmpdir)) {
    const replacement = resolveUserTempDir()
    if (replacement) {
      correct.TMPDIR = { from: tmpdir, to: replacement, reason: 'dangling-tmpdir' }
    } else {
      remove.push('TMPDIR')
    }
  }

  return { contaminated, privileged, markers: [...markers], remove, correct }
}

/**
 * The per-user temporary directory, asked of the OS rather than reconstructed.
 *
 * `os.tmpdir()` cannot be used here: it reads `$TMPDIR` first, which is the
 * exact value being repaired. `getconf DARWIN_USER_TEMP_DIR` is the primitive
 * that produced that value in the first place. Returns null off macOS and on
 * any failure, in which case the caller drops `TMPDIR` and children fall back
 * to `/tmp`.
 */
function resolveUserTempDir(): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const resolved = execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return resolved || null
  } catch (err) {
    warn('could not resolve the per-user temp directory', { error: String(err) })
    return null
  }
}

/**
 * Remove the privilege marker from an environment that is about to be handed
 * to a child process.
 *
 * `sanitizeLaunchEnvironment()` clears it from `process.env` at startup, so in
 * a normally-started desktop this finds nothing. It is applied again at the
 * point every spawn environment is built (`getCliEnv`) because that function,
 * not the startup path, is what owns the guarantee that a shell Ion starts
 * reads the operator's startup files. A future entry point that forgets the
 * startup call still cannot spawn a privileged shell.
 *
 * Returns true when a marker was present and removed.
 */
export function stripPrivilegeEscalation(env: NodeJS.ProcessEnv): boolean {
  if (env[PRIVILEGE_ESCALATION_VAR] === undefined) return false
  delete env[PRIVILEGE_ESCALATION_VAR]
  return true
}

/**
 * Repair `process.env` in place and record what was repaired.
 *
 * Call this before anything spawns a shell. `getCliPath()` probes PATH with
 * `execFileSync`, which inherits `process.env` directly, so a contaminated
 * process.env makes even PATH discovery run under a privileged shell — the
 * probes then report the system PATH, find nothing new, and the desktop falls
 * back to its own stripped PATH.
 */
export function sanitizeLaunchEnvironment(): LaunchEnvironmentPlan {
  let account: LaunchEnvironmentAccount = { username: '', homedir: '', shell: '' }
  try {
    const info = userInfo()
    account = {
      username: info.username ?? '',
      homedir: info.homedir ?? '',
      shell: info.shell?.trim() ?? '',
    }
  } catch (err) {
    warn('could not read the account record; identity repair is skipped', { error: String(err) })
  }

  const plan = planLaunchEnvironmentSanitization(process.env, account, (path) => existsSync(path))

  if (!plan.contaminated && plan.remove.length === 0 && Object.keys(plan.correct).length === 0) {
    log('launch environment is clean', {
      user: process.env.USER,
      logname: process.env.LOGNAME,
      home: process.env.HOME,
      shell: process.env.SHELL,
      privileged_shell_marker: false,
    })
    return plan
  }

  for (const name of plan.remove) delete process.env[name]
  for (const [name, correction] of Object.entries(plan.correct)) process.env[name] = correction.to

  const report = {
    contaminated: plan.contaminated,
    installer_markers: plan.markers,
    removed: plan.remove,
    corrected: Object.fromEntries(
      Object.entries(plan.correct).map(([name, c]) => [name, { from: c.from ?? null, to: c.to, reason: c.reason }]),
    ),
    user: process.env.USER,
    logname: process.env.LOGNAME,
    home: process.env.HOME,
    shell: process.env.SHELL,
    tmpdir: process.env.TMPDIR,
  }

  if (plan.privileged) {
    // WARN, not INFO: until this ran, every shell this process started skipped
    // the operator's startup files. That is a user-visible defect, and the line
    // is the evidence that the desktop was launched by the package installer.
    warn('repaired an installer launch environment that forced privileged shells', report)
  } else {
    log('repaired the launch environment', report)
  }

  return plan
}
