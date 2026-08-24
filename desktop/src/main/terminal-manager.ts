import { IPC } from '../shared/types'
import { getCliEnv } from './cli-env'
import { PRIVILEGE_ESCALATION_VAR } from './launch-env'
import { getDeepLinkToken } from './deeplink/token'
import { homedir, userInfo } from 'os'
import { basename, join } from 'path'
import { existsSync } from 'fs'
import { terminalScrollback } from './state'
import { debug as _debug, log as _log, warn as _warn } from './logger'
import type { IPty } from 'node-pty'

/**
 * A Studio pane is a login AND interactive shell, so it reads both the login
 * files and the interactive rc file (`.zprofile` then `.zshrc`).
 *
 * These arguments are correct but were never the cause of a pane that loaded
 * none of the operator's setup. A shell obeys them only when it is not running
 * PRIVILEGED; an inherited `APPLE_PKGKIT_ESCALATING_ROOT` makes it skip every
 * user startup file with these exact arguments, a real PTY, and the right
 * shell. That variable is cleared at startup — see launch-env.ts. Do not treat
 * a "missing setup" report as a shell-argument question: check the
 * `privileged_shell_marker` field on the `starting terminal pty` log line.
 */
const INTERACTIVE_LOGIN_ARGS = ['-il']

/**
 * The Zsh startup files a login+interactive shell reads, in the order it reads
 * them. `~/.zshrc` is where an operator's prompt (Starship), directory jumper
 * (Zoxide), and PATH additions almost always live, so its presence-vs-absence
 * is the single most diagnostic fact about a terminal that "looks wrong".
 *
 * A privileged shell reads only the /etc entries and silently skips every
 * user file, which is exactly the failure this record makes visible: the log
 * then shows the user files existing on disk while the shell ignored them.
 */
const ZSH_STARTUP_FILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin'] as const

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('terminal', msg, fields)
}
function log(msg: string, fields?: Record<string, unknown>): void {
  _log('terminal', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('terminal', msg, fields)
}

/**
 * Split a terminal key into its tab and instance ids.
 *
 * Keys are `"<tabId>:<instanceId>"`. Split on the FIRST colon only: a tab id is
 * a UUID today, but an instance id must never be able to swallow part of a tab
 * id if either format ever gains one.
 */
function splitTerminalKey(key: string): [tabId: string, instanceId: string] {
  const sep = key.indexOf(':')
  if (sep < 0) return [key, '']
  return [key.slice(0, sep), key.slice(sep + 1)]
}

// node-pty is a native module — require at runtime to avoid Vite bundling issues
let pty: typeof import('node-pty')
try {
  pty = require('node-pty')
} catch {
  // Will fail at create() time, not import time
}

/**
 * The `pty.spawn` surface this manager uses.
 *
 * Declared so a test can supply a spawner and observe the environment a PTY
 * would be created with. node-pty is a real native module that loads fine under
 * vitest, so without this seam a test would spawn actual shells and could not
 * inspect the spawn arguments at all.
 */
export type PtySpawner = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => IPty

/** Read node-pty's foreground-process title without spawning a subprocess. */
export type ProcessProbe = (term: Pick<IPty, 'process'>, shell: string) => boolean

function hasForegroundChildProcess(term: Pick<IPty, 'process'>, shell: string): boolean {
  return basename(term.process) !== basename(shell)
}

/** Lifecycle record for a terminal key (D2 attach model). */
export interface TerminalLifecycle {
  running: boolean
  /** Exit code of the last run; null while running or never exited. */
  exitCode: number | null
  /** The cwd the pty was created with (respawn target). */
  cwd: string
  /** True when the requested cwd was dead and the spawn fell back to ~. */
  cwdFellBack: boolean
}

/** Snapshot returned to an attaching client. */
export interface TerminalAttachInfo {
  history: string
  running: boolean
  exitCode: number | null
  cwd: string
  cwdFellBack: boolean
}

/**
 * Which Zsh startup files actually exist for a given rc directory.
 *
 * Reported so a log reader can tell "the operator has no .zshrc" (nothing to
 * load, working as configured) apart from "the .zshrc exists and the shell
 * ignored it" (a privileged shell, which is a defect). Without this the two
 * produce an identical bare prompt and identical logs.
 */
function presentZshStartupFiles(rcDir: string): string[] {
  if (!rcDir) return []
  return ZSH_STARTUP_FILES.filter((name) => {
    try {
      return existsSync(join(rcDir, name))
    } catch {
      // An unreadable rc directory is reported as "file absent" rather than
      // throwing: this probe is diagnostic and must never stop a terminal from
      // starting. The rcDir itself is in the same log line, so a reader can
      // still see which directory was consulted.
      return false
    }
  })
}

export class TerminalManager {
  private sessions = new Map<string, IPty>()
  private activeKeys = new Set<string>()
  private activityTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * Lifecycle state OUTLIVES the pty (attach model): a pty EXIT retains the
   * scrollback + exit code so a dead terminal stays readable until explicit
   * destroy. Only destroy()/destroyByPrefix()/destroyAll() delete.
   */
  private lifecycle = new Map<string, TerminalLifecycle>()
  private broadcast: (channel: string, ...args: unknown[]) => void
  private spawner: PtySpawner | null
  private processProbe: ProcessProbe

  constructor(broadcast: (channel: string, ...args: unknown[]) => void, spawner?: PtySpawner, processProbe?: ProcessProbe) {
    this.broadcast = broadcast
    this.processProbe = processProbe ?? hasForegroundChildProcess
    // Production passes nothing and gets node-pty; tests inject a spy.
    this.spawner = spawner ?? null
  }

  /**
   * Attach snapshot: full history + lifecycle state. With
   * restartIfNotRunning, a dead (or never-created) terminal respawns on
   * demand; a dead cwd falls back to ~ and says so (visible notice).
   */
  attach(key: string, opts?: { restartIfNotRunning?: boolean; cwd?: string }): TerminalAttachInfo {
    let life = this.lifecycle.get(key)
    if (opts?.restartIfNotRunning && !this.sessions.has(key)) {
      const cwd = opts.cwd ?? life?.cwd ?? '~'
      this.create(key, cwd)
      life = this.lifecycle.get(key)
    }
    return {
      history: terminalScrollback.get(key) ?? '',
      running: this.sessions.has(key),
      exitCode: life?.exitCode ?? null,
      cwd: life?.cwd ?? '~',
      cwdFellBack: life?.cwdFellBack ?? false,
    }
  }

  /** Lifecycle state for a key (undefined = never created). */
  getLifecycle(key: string): TerminalLifecycle | undefined {
    return this.lifecycle.get(key)
  }

  create(key: string, cwd: string): void {
    if (this.sessions.has(key)) return

    const spawn = this.spawner ?? (pty ? pty.spawn : null)
    if (!spawn) {
      throw new Error('node-pty is not available')
    }

    const requested = cwd === '~' ? homedir() : cwd
    const cwdFellBack = !existsSync(requested)
    const resolvedCwd = cwdFellBack ? homedir() : requested
    const loginShell = this.resolveLoginShell()

    // Conversation identity, injected into the PTY environment.
    //
    // This is what lets `dev run` (or any tool) open a pane in THE CONVERSATION
    // IT WAS RUN FROM rather than in whichever tab happens to be focused. Every
    // descendant of this shell inherits these vars, so a tool at any depth can
    // name its own tab, and a pane it spawns carries its own ids in turn.
    //
    // Resolving the target from focus instead would be a heuristic that breaks
    // the moment the operator navigates away — which is precisely the case that
    // matters, since services are launched and then read later.
    //
    // The token is included so a local tool's request is recognised as coming
    // from this machine and does not need a human confirmation. That is not an
    // escalation: anything able to read this PTY's environment can already spawn
    // processes as this user. See deeplink/token.ts.
    const [tabId, instanceId] = splitTerminalKey(key)
    const env = getCliEnv({
      ION_DESKTOP_TAB_ID: tabId,
      ION_DESKTOP_TERMINAL_INSTANCE_ID: instanceId,
      ION_DESKTOP_DEEPLINK_TOKEN: getDeepLinkToken(),
    }) as Record<string, string>

    const ptyEnv: Record<string, string> = { ...env, SHELL: loginShell }

    // Startup evidence, written BEFORE the spawn.
    //
    // This is at INFO on purpose. A terminal whose prompt, PATH, or tools are
    // missing is reported by the operator hours later, from a packaged build
    // with no DevTools, and a DEBUG line that the default level discards is
    // not evidence — it is a blind spot. These fields are what distinguish the
    // three failure modes that look identical on screen:
    //
    //   - wrong shell selected      -> shell / account_shell disagree
    //   - startup files not on disk -> startup_files_present is short
    //   - shell refused to read them-> privileged_shell_marker is true
    //
    // The environment values are recorded by name and value because each one
    // changes which files the shell reads: ZDOTDIR relocates them entirely,
    // HOME decides where they are looked up, and USER/LOGNAME decide which
    // account the shell believes it is.
    log('starting terminal pty', {
      key,
      shell: loginShell,
      shell_args: INTERACTIVE_LOGIN_ARGS,
      requested_cwd: requested,
      resolved_cwd: resolvedCwd,
      cwd_fell_back: cwdFellBack,
      env_home: ptyEnv.HOME,
      env_user: ptyEnv.USER,
      env_logname: ptyEnv.LOGNAME,
      env_shell: ptyEnv.SHELL,
      env_zdotdir: ptyEnv.ZDOTDIR ?? null,
      env_term: ptyEnv.TERM,
      env_term_program: ptyEnv.TERM_PROGRAM ?? null,
      env_lang: ptyEnv.LANG ?? null,
      env_path_entries: ptyEnv.PATH ? ptyEnv.PATH.split(':').length : 0,
      env_path: ptyEnv.PATH,
      privileged_shell_marker: ptyEnv[PRIVILEGE_ESCALATION_VAR] !== undefined,
      startup_files_present: presentZshStartupFiles(ptyEnv.ZDOTDIR || ptyEnv.HOME || homedir()),
    })

    let term: IPty
    try {
      // Studio terminals are interactive login shells, so the shell reads both
      // its login files and its interactive rc file (.zprofile + .zshrc).
      term = spawn(loginShell, INTERACTIVE_LOGIN_ARGS, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: resolvedCwd,
        env: ptyEnv,
      })
    } catch (err: unknown) {
      // A spawn failure leaves no PTY to report through, so this is the only
      // place the operator's "the terminal did nothing" can be explained.
      warn('terminal pty failed to start', {
        key,
        shell: loginShell,
        shell_args: INTERACTIVE_LOGIN_ARGS,
        cwd: resolvedCwd,
        error: String(err),
      })
      throw err
    }

    log('terminal pty started', {
      key,
      shell: loginShell,
      pid: term.pid,
      cwd: resolvedCwd,
      cwd_fell_back: cwdFellBack,
      cols: 80,
      rows: 24,
    })

    term.onData((data: string) => {
      this.broadcast(IPC.TERMINAL_INCOMING, key, data)
    })

    term.onExit(({ exitCode }: { exitCode: number }) => {
      this.sessions.delete(key)
      this.stopActivityWatch(key)
      this.setActivity(key, false)
      // Exit RETAINS scrollback + exit code (attach model): the dead
      // terminal stays readable until explicit destroy.
      const life = this.lifecycle.get(key)
      if (life) this.lifecycle.set(key, { ...life, running: false, exitCode })
      this.broadcast(IPC.TERMINAL_EXIT, key, exitCode)
    })

    this.sessions.set(key, term)
    this.startActivityWatch(key, term, loginShell)
    this.lifecycle.set(key, { running: true, exitCode: null, cwd: resolvedCwd, cwdFellBack })
    // A fresh run's transcript starts clean (a respawn after exit would
    // otherwise repeat the dead run's history ahead of the new shell).
    terminalScrollback.delete(key)
  }


  /**
   * The shell to start a pane with: the account's login shell.
   *
   * Read from the account record rather than `$SHELL`, because `$SHELL` is
   * inherited from whatever launched Ion and is wrong exactly when it matters
   * — a package-installer launch supplies `SHELL=/bin/sh`. The account record
   * is the operator's real configured shell in every launch path.
   */
  private resolveLoginShell(): string {
    try {
      const accountShell = userInfo().shell?.trim()
      if (accountShell) {
        debug('resolved account login shell', {
          account_shell: accountShell,
          inherited_shell: process.env.SHELL ?? null,
        })
        return accountShell
      }
      warn('account record has no shell; using the default shell', {
        fallback_shell: '/bin/zsh',
        inherited_shell: process.env.SHELL ?? null,
      })
      return '/bin/zsh'
    } catch (err: unknown) {
      warn('could not read the account record; using the default shell', {
        fallback_shell: '/bin/zsh',
        inherited_shell: process.env.SHELL ?? null,
        error: String(err),
      })
      return '/bin/zsh'
    }
  }

  write(key: string, data: string): void {
    this.sessions.get(key)?.write(data)
  }

  activeTabIds(): string[] {
    return [...new Set([...this.activeKeys].map((key) => splitTerminalKey(key)[0]))]
  }

  private setActivity(key: string, active: boolean): void {
    const wasActive = this.activeKeys.has(key)
    if (active === wasActive) return

    const [tabId] = splitTerminalKey(key)
    const wasTabActive = this.activeTabIds().includes(tabId)
    if (active) this.activeKeys.add(key)
    else this.activeKeys.delete(key)
    const isTabActive = this.activeTabIds().includes(tabId)

    // Renderers show activity per tab. A new active PTY still emits its own
    // identity so observers can associate it with the pane that started it. Do
    // not mark a tab idle while another PTY in that tab has a foreground child
    // process.
    if (!active && wasTabActive === isTabActive) return
    this.broadcast(IPC.TERMINAL_ACTIVITY, { key, tabId, active: isTabActive })
    debug('terminal activity changed', { key, tab_id: tabId, active: isTabActive })
  }

  private startActivityWatch(key: string, term: IPty, shell: string): void {
    this.stopActivityWatch(key)
    const refresh = (): void => {
      if (this.sessions.get(key) !== term) return
      try {
        this.setActivity(key, this.processProbe(term, shell))
      } catch (err: unknown) {
        debug('terminal activity probe failed', { key, error: String(err) })
      }
      if (this.sessions.get(key) === term) {
        this.activityTimers.set(key, setTimeout(refresh, 500))
      }
    }
    refresh()
  }

  private stopActivityWatch(key: string): void {
    const timer = this.activityTimers.get(key)
    if (timer) clearTimeout(timer)
    this.activityTimers.delete(key)
  }

  resize(key: string, cols: number, rows: number): void {
    try {
      this.sessions.get(key)?.resize(cols, rows)
    } catch {
      // Ignore resize errors on dead PTYs
    }
  }

  destroy(key: string): void {
    const term = this.sessions.get(key)
    if (term) {
      this.sessions.delete(key)
      this.stopActivityWatch(key)
      this.setActivity(key, false)
      terminalScrollback.delete(key)
      try {
        term.kill()
      } catch {
        // Already dead
      }
    }
    // Explicit destroy is the ONE path that forgets a terminal: scrollback
    // and lifecycle state go together (exit alone retains both).
    terminalScrollback.delete(key)
    this.lifecycle.delete(key)
  }

  /** Destroy all PTYs matching a prefix (e.g. "tabId:" destroys all terminals for that tab) */
  destroyByPrefix(prefix: string): void {
    for (const key of this.sessions.keys()) {
      if (key.startsWith(prefix)) {
        this.destroy(key)
      }
    }
  }

  destroyAll(): void {
    for (const key of this.sessions.keys()) {
      this.destroy(key)
    }
  }
}
