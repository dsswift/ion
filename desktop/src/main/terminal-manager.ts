import { IPC } from '../shared/types'
import { getCliEnv } from './cli-env'
import { getDeepLinkToken } from './deeplink/token'
import { homedir, userInfo } from 'os'
import { basename } from 'path'
import { existsSync } from 'fs'
import { terminalScrollback } from './state'
import { debug as _debug } from './logger'
import type { IPty } from 'node-pty'

const INTERACTIVE_LOGIN_ARGS = ['-il']

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('terminal', msg, fields)
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

    debug('resolved terminal spawn inputs', {
      key,
      requested_cwd: requested,
      resolved_cwd: resolvedCwd,
      cwd_fell_back: cwdFellBack,
      login_shell: loginShell,
      login_args: INTERACTIVE_LOGIN_ARGS,
    })

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

    // Studio terminals are interactive login shells. The PTY often makes Zsh
    // infer interactivity, but that inference changed with the packaged-app
    // launch path. Pass both modes explicitly so the shell always reads its
    // login files and interactive rc file (for example, .zprofile + .zshrc).
    const term = spawn(loginShell, INTERACTIVE_LOGIN_ARGS, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: resolvedCwd,
      env: { ...env, SHELL: loginShell },
    })

    debug('spawned terminal pty', {
      key,
      shell: loginShell,
      login_args: INTERACTIVE_LOGIN_ARGS,
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


  private resolveLoginShell(): string {
    try {
      const accountShell = userInfo().shell?.trim()
      if (accountShell) {
        debug('resolved account login shell', { account_shell: accountShell })
        return accountShell
      }
      debug('account shell missing, falling back to default shell', { fallback_shell: '/bin/zsh' })
      return '/bin/zsh'
    } catch (err: unknown) {
      debug('failed to resolve account shell, falling back to default shell', {
        fallback_shell: '/bin/zsh',
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
