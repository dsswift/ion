import { IPC } from '@ion/shared/types'
import { getCliEnv } from '../cli-env'
import { PRIVILEGE_ESCALATION_VAR } from '../launch-env'
import { getDeepLinkToken } from '../deeplink/token'
import { homedir } from 'os'
import { join, delimiter } from 'path'
import { terminalProcessTree } from './terminal-process-tree'
import { readProcessSnapshot, stopTerminalProcesses, defaultTerminalStopDeps, type TerminalStopDeps } from './terminal-stop'
import { resolveShell } from './terminal-shell'
import { describeSpawnHelper, ensureSpawnHelperExecutable, spawnHelperHint } from './terminal-spawn-helper'
import { discoverTerminalWebApplications } from './terminal-application-discovery'
import type { TerminalActivity } from '@ion/shared/terminal-activity'
import { splitTerminalActivityKey } from '@ion/shared/terminal-activity'
import { existsSync } from 'fs'
import { terminalScrollback } from '../state'
import { debug as _debug, log as _log, warn as _warn } from '../logger'
import type { IPty } from 'node-pty'
import type { PtySpawner, TerminalLifecycle, TerminalAttachInfo } from './terminal-manager-types'

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
  // Native module load must stay lazy so a missing binary fails at create()
  // time (caught below) instead of at import time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pty = require('node-pty')
} catch {
  // Will fail at create() time, not import time
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
  private activities = new Map<string, TerminalActivity>()
  private activeKeys = new Set<string>()
  private activityTimer: ReturnType<typeof setTimeout> | null = null
  private activityPollInFlight = false
  private lastWebDiscoveryAt = 0
  /**
   * Lifecycle state OUTLIVES the pty (attach model): a pty EXIT retains the
   * scrollback + exit code so a dead terminal stays readable until explicit
   * destroy. Only destroy()/destroyByPrefix()/destroyAll() delete.
   */
  private lifecycle = new Map<string, TerminalLifecycle>()
  /** Resolves when a PTY reports its exit; see stopTerminalProcesses. */
  private exits = new WeakMap<IPty, Promise<void>>()
  /** Relaunches under way, by key. A key in here takes no other spawn. */
  private relaunches = new Map<string, Promise<void>>()
  /** Overridable so a test can stop fake process trees without waiting. */
  stopDeps: TerminalStopDeps = defaultTerminalStopDeps
  private broadcast: (channel: string, ...args: unknown[]) => void
  private spawner: PtySpawner | null
  private legacyProcessProbe: ((term: Pick<IPty, 'process'>, shell: string) => boolean) | null

  constructor(broadcast: (channel: string, ...args: unknown[]) => void, spawner?: PtySpawner, legacyProcessProbe?: (term: Pick<IPty, 'process'>, shell: string) => boolean) {
    this.broadcast = broadcast
    this.legacyProcessProbe = legacyProcessProbe ?? null
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
    if (opts?.restartIfNotRunning && !this.sessions.has(key) && !this.relaunches.has(key)) {
      const cwd = opts.cwd ?? life?.cwd ?? '~'
      try {
        this.create(key, cwd)
      } catch (err) {
        // create() has already logged the diagnosis and recorded it on the
        // lifecycle; the attach answers with it rather than rejecting, so
        // the client renders the reason in the terminal instead of a cursor
        // over nothing. Typing retries through the same attach.
        debug('attach: spawn failed; answering with startError', { key, error: String(err) })
      }
      life = this.lifecycle.get(key)
    }
    return {
      history: terminalScrollback.get(key) ?? '',
      running: this.sessions.has(key),
      exitCode: life?.exitCode ?? null,
      cwd: life?.cwd ?? '~',
      cwdFellBack: life?.cwdFellBack ?? false,
      startError: life?.startError ?? null,
    }
  }

  /** Lifecycle state for a key (undefined = never created). */
  getLifecycle(key: string): TerminalLifecycle | undefined {
    return this.lifecycle.get(key)
  }

  create(key: string, cwd: string): void {
    if (this.relaunches.has(key)) {
      // The relaunch spawns this key's shell at the cwd it was asked for. A
      // client's create racing it would win with its own, older cwd.
      debug('terminal create skipped: relaunch in progress', { key })
      return
    }
    this.spawn(key, cwd)
  }

  /**
   * Stop everything the terminal at `key` runs, then start a fresh shell in
   * `cwd` under the same key. Clients hear `TERMINAL_RESTARTED` (never
   * `TERMINAL_EXIT`) and clear their view. Concurrent relaunches of one key
   * run one after another. Rejects when the new shell fails to start.
   */
  relaunch(key: string, cwd: string): Promise<void> {
    const prior = this.relaunches.get(key)
    const run = (prior ? prior.then(() => this.relaunchNow(key, cwd), () => this.relaunchNow(key, cwd)) : this.relaunchNow(key, cwd))
    this.relaunches.set(key, run)
    const clear = (): void => { if (this.relaunches.get(key) === run) this.relaunches.delete(key) }
    void run.then(clear, clear)
    return run
  }

  private async relaunchNow(key: string, cwd: string): Promise<void> {
    const old = this.sessions.get(key)
    if (old) {
      // Detached first, so the old PTY's exit and trailing output are
      // recognised as a replaced session's and never reach a client.
      this.sessions.delete(key)
      this.clearActivity(key)
      const stop = await stopTerminalProcesses(old, this.exits.get(old) ?? Promise.resolve(), this.stopDeps)
      const fields = { key, pid: old.pid, descendants: stop.descendants.length, forced: stop.forced, survivors: stop.survivors, shell_exited: stop.shellExited, tree_error: stop.treeError ?? '' }
      if (stop.survivors.length > 0 || !stop.shellExited || stop.treeError) warn('terminal relaunch: previous processes did not stop cleanly', fields)
      else log('terminal relaunch: previous processes stopped', fields)
    } else {
      log('terminal relaunch: no running shell to stop', { key })
    }
    this.lifecycle.delete(key)
    terminalScrollback.delete(key)
    let startError: string | null = null
    try {
      this.spawn(key, cwd)
    } catch (err: unknown) {
      startError = this.lifecycle.get(key)?.startError ?? String(err)
    }
    this.broadcast(IPC.TERMINAL_RESTARTED, key, startError)
    if (startError) throw new Error(startError)
  }

  private spawn(key: string, cwd: string): void {
    if (this.sessions.has(key)) return

    const spawn = this.spawner ?? (pty ? pty.spawn : null)
    if (!spawn) {
      throw new Error('node-pty is not available')
    }

    const requested = cwd === '~' ? homedir() : cwd
    const cwdFellBack = !existsSync(requested)
    const resolvedCwd = cwdFellBack ? homedir() : requested
    const shell = resolveShell()

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

    const ptyEnv: Record<string, string> = { ...env, SHELL: shell.shell }

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
    //
    // startup_files_present only means something for a zsh shell (it is the
    // interactive-rc probe from resolveLoginShell's Unix path); a Windows
    // shell family has no equivalent concept, so the field is null there
    // rather than a misleading empty array.
    log('starting terminal pty', {
      key,
      shell: shell.shell,
      shell_args: shell.args,
      shell_family: shell.family,
      shell_reason: shell.reason,
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
      env_path_entries: ptyEnv.PATH ? ptyEnv.PATH.split(delimiter).length : 0,
      env_path: ptyEnv.PATH,
      privileged_shell_marker: ptyEnv[PRIVILEGE_ESCALATION_VAR] !== undefined,
      startup_files_present: shell.family === 'zsh' ? presentZshStartupFiles(ptyEnv.ZDOTDIR || ptyEnv.HOME || homedir()) : null,
    })

    // Backstop for a helper npm left non-executable (the packaging pipeline
    // and postinstall set the bit where the files are written; this covers a
    // tree neither touched). Logged either way so the spawn below is never a
    // mystery: a repair here is why a previously broken install starts
    // working, and a refusal here is why the spawn is about to fail.
    const repair = ensureSpawnHelperExecutable()
    if (repair.repaired) {
      log('restored the execute bit on node-pty spawn-helper', { key, path: repair.status.path ?? '' })
    } else if (repair.error) {
      warn('node-pty spawn-helper is not executable and could not be repaired', { key, path: repair.status.path ?? '', error: repair.error })
    }

    let term: IPty
    try {
      // Studio terminals are interactive login shells on unix, so the shell
      // reads both its login files and its interactive rc file (.zprofile +
      // .zshrc). On Windows there is no login-shell concept; shell.args
      // carries only what suppresses the PowerShell banner.
      term = spawn(shell.shell, shell.args, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: resolvedCwd,
        env: ptyEnv,
      })
    } catch (err: unknown) {
      // A spawn failure leaves no PTY to report through, so this is the only
      // place the operator's "the terminal did nothing" can be explained.
      // "posix_spawnp failed." on its own names nothing; the spawn-helper
      // status below is the usual cause on a scripted install.
      const helper = describeSpawnHelper()
      const hint = spawnHelperHint(helper)
      warn('terminal pty failed to start', {
        key,
        shell: shell.shell,
        shell_args: shell.args,
        cwd: resolvedCwd,
        error: String(err),
        spawn_helper_path: helper.path ?? '',
        spawn_helper_exists: helper.exists,
        spawn_helper_executable: helper.executable,
        hint: hint ?? '',
      })
      // Recorded so attach() can hand the client the same diagnosis the log
      // has. Not running, no exit code: the shell never existed, and an exit
      // code left over from an earlier run would misreport this attempt as
      // "exited" rather than "never started".
      this.lifecycle.set(key, {
        running: false,
        exitCode: null,
        cwd: resolvedCwd,
        cwdFellBack,
        startError: hint ? `${String(err)} -- ${hint}` : String(err),
      })
      throw err
    }

    log('terminal pty started', {
      key,
      shell: shell.shell,
      pid: term.pid,
      cwd: resolvedCwd,
      cwd_fell_back: cwdFellBack,
      cols: 80,
      rows: 24,
    })

    // The first chunk is logged so a terminal that "did nothing" can be
    // told apart from one whose output was produced and then lost on the
    // way to a client. Every chunk after it stays silent.
    let firstOutputLogged = false
    let markExited: () => void = () => {}
    this.exits.set(term, new Promise<void>((resolve) => { markExited = resolve }))
    term.onData((data: string) => {
      // A destroyed or relaunched session's trailing output belongs to no
      // terminal any client is showing.
      if (this.sessions.get(key) !== term) return
      if (!firstOutputLogged) {
        firstOutputLogged = true
        log('terminal first output', { key, bytes: data.length })
      }
      this.broadcast(IPC.TERMINAL_INCOMING, key, data)
    })

    term.onExit(({ exitCode }: { exitCode: number }) => {
      markExited()
      if (this.sessions.get(key) !== term) {
        // Destroyed or relaunched: the key has moved on, and an exit here
        // would make clients respawn or mark dead the shell that replaced it.
        debug('terminal pty exit ignored: session was replaced', { key, pid: term.pid, exit_code: exitCode })
        return
      }
      this.sessions.delete(key)
      this.clearActivity(key)
      if (this.sessions.size === 0) this.stopActivityWatch()
      // Exit RETAINS scrollback + exit code (attach model): the dead
      // terminal stays readable until explicit destroy.
      const life = this.lifecycle.get(key)
      if (life) this.lifecycle.set(key, { ...life, running: false, exitCode })
      this.broadcast(IPC.TERMINAL_EXIT, key, exitCode)
    })

    this.sessions.set(key, term)
    if (this.legacyProcessProbe) {
      const ids = splitTerminalActivityKey(key)
      if (this.legacyProcessProbe(term, shell.shell)) {
        this.publishActivity({ key, ...ids, active: true, processLabel: null, processIds: [term.pid], applications: [] })
      }
    }
    this.startActivityWatch(!this.legacyProcessProbe)
    this.lifecycle.set(key, { running: true, exitCode: null, cwd: resolvedCwd, cwdFellBack, startError: null })
    // A fresh run's transcript starts clean (a respawn after exit would
    // otherwise repeat the dead run's history ahead of the new shell).
    terminalScrollback.delete(key)
  }

  write(key: string, data: string): void {
    const term = this.sessions.get(key)
    if (!term) {
      debug('terminal write dropped: no running session', { key, bytes: data.length })
      return
    }
    debug('terminal write', { key, bytes: data.length })
    term.write(data)
  }

  activeTabIds(): string[] {
    return [...new Set([...this.activities.values()].filter((activity) => activity.active).map((activity) => activity.tabId))]
  }

  activitySnapshot(): TerminalActivity[] {
    return [...this.activities.values()]
  }

  private publishActivity(activity: TerminalActivity): void {
    this.activities.set(activity.key, activity)
    const payload = this.legacyProcessProbe
      ? { key: activity.key, tabId: activity.tabId, active: activity.active }
      : activity
    this.broadcast(IPC.TERMINAL_ACTIVITY, payload)
    debug('terminal activity changed', {
      key: activity.key,
      tab_id: activity.tabId,
      active: activity.active,
      process_label: activity.processLabel ?? '',
      process_count: activity.processIds.length,
    })
  }

  private clearActivity(key: string): void {
    const previous = this.activities.get(key)
    if (!previous) return
    this.publishActivity({ ...previous, active: false, processLabel: null, processIds: [], applications: [] })
    this.activities.delete(key)
  }

  private startActivityWatch(immediate = true): void {
    if (this.activityTimer || this.sessions.size === 0) return
    const refresh = async (): Promise<void> => {
      this.activityTimer = null
      if (this.activityPollInFlight || this.sessions.size === 0) return
      this.activityPollInFlight = true
      try {
        if (this.legacyProcessProbe) {
          for (const [key, term] of this.sessions) {
            const previous = this.activities.get(key)
            const active = this.legacyProcessProbe(term, '')
            if (active && !previous?.active) {
              this.publishActivity({ key, ...splitTerminalActivityKey(key), active: true, processLabel: null, processIds: [term.pid], applications: [] })
            } else if (!active && previous?.active) {
              this.clearActivity(key)
            }
          }
        } else {
          const snapshot = await readProcessSnapshot()
          const nextActivities: TerminalActivity[] = []
          for (const [key, term] of this.sessions) {
            const tree = terminalProcessTree(snapshot, term.pid)
            nextActivities.push({ key, ...splitTerminalActivityKey(key), active: tree.active, processLabel: tree.processLabel, processIds: tree.processIds, cwd: this.lifecycle.get(key)?.cwd, applications: [] })
          }
        let webApplications = new Map<string, import('@ion/shared/terminal-activity').TerminalWebApplication[]>()
        const shouldDiscoverWeb = Date.now() - this.lastWebDiscoveryAt >= 3_000
        if (shouldDiscoverWeb) {
          try {
            webApplications = await discoverTerminalWebApplications(nextActivities)
            this.lastWebDiscoveryAt = Date.now()
          } catch (err: unknown) {
            // Web Application discovery is an enrichment. A missing lsof binary,
            // a slow listener scan, or a probe failure must never hide the exact
            // terminal process activity that was already proven by the process tree.
            debug('terminal web application discovery failed', { error: String(err), active_terminal_count: nextActivities.length })
          }
        } else {
          for (const activity of nextActivities) {
            const previous = this.activities.get(activity.key)
            if (previous?.applications.length) webApplications.set(activity.key, previous.applications)
          }
        }
        for (const next of nextActivities) {
          next.applications = webApplications.get(next.key) ?? []
          const previous = this.activities.get(next.key)
          if (!previous || previous.active !== next.active || previous.processLabel !== next.processLabel || previous.processIds.join(',') !== next.processIds.join(',') || JSON.stringify(previous.applications) !== JSON.stringify(next.applications)) {
            this.publishActivity(next)
          }
        }
      }
      } catch (err: unknown) {
        debug('terminal activity process snapshot failed', { error: String(err), session_count: this.sessions.size })
      } finally {
        this.activityPollInFlight = false
        if (this.sessions.size > 0) this.activityTimer = setTimeout(() => void refresh(), 500)
      }
    }
    if (immediate) void refresh()
    else this.activityTimer = setTimeout(() => void refresh(), 500)
  }

  private stopActivityWatch(): void {
    if (this.activityTimer) clearTimeout(this.activityTimer)
    this.activityTimer = null
  }

  /**
   * Apply a renderer-measured size to the PTY.
   *
   * Logged on every branch because a PTY that never resizes is invisible
   * otherwise: it spawns at 80x24 and simply stays there, which presents as
   * "the terminal wraps at the wrong width" with nothing in the log to
   * distinguish "no resize arrived" from "a resize arrived with bad numbers".
   * That ambiguity cost a full diagnostic round on Windows, where a
   * macOS-only default font made xterm measure absurd columns.
   */
  resize(key: string, cols: number, rows: number): void {
    const session = this.sessions.get(key)
    if (!session) {
      debug('terminal resize skipped; no live pty', { key, cols, rows })
      return
    }
    // A zero or absurd measurement means the renderer measured a hidden or
    // unstyled element. Applying it would wedge the PTY at a useless width,
    // so it is refused and named rather than silently forwarded.
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 2 || rows < 2) {
      warn('terminal resize refused; implausible dimensions', { key, cols, rows })
      return
    }
    try {
      session.resize(cols, rows)
      debug('terminal resized', { key, cols, rows })
    } catch (err: unknown) {
      // A dead PTY is the ordinary case here (the process exited between the
      // renderer measuring and this call), so this is not an error.
      debug('terminal resize failed; pty likely exited', { key, cols, rows, error: String(err) })
    }
  }

  destroy(key: string): void {
    const term = this.sessions.get(key)
    if (term) {
      this.sessions.delete(key)
      this.clearActivity(key)
      if (this.sessions.size === 0) this.stopActivityWatch()
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
