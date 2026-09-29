/**
 * local-server — spawns the bundled Studio server (`server/dist/main.js`) as
 * a child process and supervises it (spec 12 §Functional "Local server").
 *
 * Respawn ladder: 1s / 2s / 4s / 8s, five attempts inside a five-minute
 * window; the sixth failure inside that window gives up and reports
 * `offline{reason: 'server_unreachable'}` instead of scheduling another
 * attempt. `restart()` re-arms the ladder from zero — the tray/Studio
 * "Restart" action.
 *
 * stdout/stderr are piped into `desktop.jsonl` at DEBUG: the packaged app has
 * no console, so the server's own log lines are the only record of why it
 * exited. The child never inherits `ION_STUDIO_LOCAL_ONLY` (spec: "unset")
 * even if the desktop process itself somehow has it set.
 */
import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { EventEmitter } from 'events'
import { log as _log, debug as _debug, warn as _warn, error as _error } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('local-server', msg, fields)
}
function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('local-server', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('local-server', msg, fields)
}
function error(msg: string, fields?: Record<string, unknown>): void {
  _error('local-server', msg, fields)
}

const RESPAWN_LADDER_MS = [1000, 2000, 4000, 8000]
const RESPAWN_WINDOW_MS = 5 * 60_000
const MAX_ATTEMPTS = 5

/**
 * Resolves the bundled server entry point: `app.asar.unpacked/dist/server/main.js`
 * in the packaged app, or `<repo>/server/dist/main.js` in dev (the desktop
 * app path is `<repo>/desktop`, so one join up reaches the workspace root).
 * Returns null when neither location has the file — the caller reports that
 * as an immediate offline rather than throwing out of `spawn()`.
 *
 * The packaged copy lives inside the app's own tree (staged to dist/server by
 * scripts/stage-server-bundle.js), unpacked, rather than as an extra resource: the server bundle keeps `node-pty` external (a
 * native addon), and Node resolves that by walking up from main.js to a real
 * `node_modules/` — which `app.asar.unpacked/node_modules/node-pty` is. A
 * copy under `Resources/server/` had nothing above it and died on its first
 * import with ERR_MODULE_NOT_FOUND, so the LOCAL environment was offline on
 * every packaged launch.
 */
/**
 * Where the Visualizer's bundled theme packs live for this build:
 * `app.asar.unpacked/resources/studio/themes` when packaged (see
 * `asarUnpack` in package.json), `<repo>/desktop/resources/studio/themes` in
 * dev. Handed to the server child as `ION_STUDIO_THEMES_BUNDLED_DIR`.
 */
export function resolveBundledThemesDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'studio', 'themes')
    : join(app.getAppPath(), 'resources', 'studio', 'themes')
}

export function resolveServerEntryPath(): string | null {
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'server', 'main.js')
    : join(app.getAppPath(), '..', 'server', 'dist', 'main.js')
  if (!existsSync(candidate)) {
    warn('resolveServerEntryPath: bundled server entry not found', { candidate, packaged: app.isPackaged })
    return null
  }
  return candidate
}

/** Splits arbitrary chunk boundaries back into whole lines for one log call per line. */
/**
 * How much of the child's stderr travels with its exit line. Enough to carry a
 * stack trace, bounded so a chatty failure cannot push the log around.
 */
const STDERR_TAIL_LINES = 20

class LineBuffer {
  private carry = ''
  constructor(private readonly onLine: (line: string) => void) {}
  push(chunk: Buffer): void {
    const text = this.carry + chunk.toString('utf-8')
    const lines = text.split('\n')
    this.carry = lines.pop() ?? ''
    for (const line of lines) {
      if (line.length > 0) this.onLine(line)
    }
  }
  flush(): void {
    if (this.carry.length > 0) this.onLine(this.carry)
    this.carry = ''
  }
}

export interface LocalServerEvents {
  offline: (reason: string) => void
}

export interface LocalServerSupervisorOptions {
  /** Absolute path to the server entry (`server/dist/main.js` or the packaged resource copy). Resolved via `resolveServerEntryPath()` by default. */
  entryPath?: string | null
  dataDir?: string
  /** This desktop's version, passed to the server as `ION_HOST_APP_VERSION` so it can report the app it runs under. */
  hostAppVersion?: string
  /** Injectable for tests: defaults to Node's `child_process.spawn`. */
  spawnFn?: typeof spawn
}

/**
 * Supervises one local Studio server child process for the lifetime of the
 * desktop app. `start()` spawns it; `stop()` is a deliberate shutdown (no
 * respawn); `restart()` re-arms the ladder and spawns immediately (the
 * operator's "Restart" action after an `offline` report).
 */
/** How long a graceful stop waits for the server's own shutdown sequence before killing the child. */
export const GRACEFUL_STOP_TIMEOUT_MS = 5000

export class LocalServerSupervisor extends EventEmitter {
  private child: ChildProcess | null = null
  /** The child's last stderr lines, reported with its exit. Reset per spawn. */
  private recentStderr: string[] = []
  private attempts = 0
  private windowStartMs = 0
  private stoppedByUser = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly entryPath: string | null
  private readonly dataDir: string | undefined
  private readonly hostAppVersion: string | undefined
  private readonly spawnFn: typeof spawn

  constructor(opts: LocalServerSupervisorOptions = {}) {
    super()
    this.entryPath = opts.entryPath !== undefined ? opts.entryPath : resolveServerEntryPath()
    this.dataDir = opts.dataDir
    this.hostAppVersion = opts.hostAppVersion
    this.spawnFn = opts.spawnFn ?? spawn
  }

  start(): void {
    this.stoppedByUser = false
    this.spawnChild()
  }

  /** Re-arms the ladder from zero and spawns immediately (the "Restart" action). */
  restart(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.attempts = 0
    this.windowStartMs = 0
    this.stoppedByUser = false
    log('restart requested; re-arming respawn ladder')
    this.spawnChild()
  }

  /** The child's pid, or null when none is running. */
  get pid(): number | null {
    return this.child?.pid ?? null
  }

  /**
   * Deliberate shutdown: asks the child to stop gracefully (SIGTERM runs the
   * server's own shutdown sequence: persist, stop jobs, drop the engine
   * socket while leaving sessions running), waits up to `timeoutMs` for it
   * to exit, and only then kills it. Does not respawn. Idempotent; logs what
   * it found so a quit path that forgot to call it is visible by its absence.
   */
  async stop(timeoutMs = GRACEFUL_STOP_TIMEOUT_MS): Promise<void> {
    this.stoppedByUser = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const child = this.child
    log('stopping local server', { pid: child?.pid ?? 0, was_running: child !== null, timeout_ms: timeoutMs })
    if (!child) return
    child.kill('SIGTERM')
    const exited = await this.waitForExit(timeoutMs)
    if (!exited) {
      warn('local server did not exit after SIGTERM; killing', { pid: child.pid ?? 0, timeout_ms: timeoutMs })
      child.kill('SIGKILL')
      await this.waitForExit(1000)
    }
    if (this.child === child) this.child = null
  }

  /** Send the child a signal it understands (SIGUSR1: drain, then stop sessions and exit). */
  signal(sig: NodeJS.Signals): boolean {
    if (!this.child) {
      log('signal requested with no local server running', { signal: sig })
      return false
    }
    log('signalling local server', { pid: this.child.pid ?? 0, signal: sig })
    return this.child.kill(sig)
  }

  /**
   * Resolve true once the current child has exited, false when `timeoutMs`
   * elapses first; resolves true at once when nothing is running. No timeout
   * means wait indefinitely (the drain-quit).
   */
  waitForExit(timeoutMs?: number): Promise<boolean> {
    const child = this.child
    if (!child) return Promise.resolve(true)
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const done = (exited: boolean): void => {
        if (timer) clearTimeout(timer)
        child.off('exit', onExit)
        resolve(exited)
      }
      const onExit = (): void => done(true)
      child.once('exit', onExit)
      if (timeoutMs !== undefined) timer = setTimeout(() => done(false), timeoutMs)
    })
  }

  private spawnChild(): void {
    if (!this.entryPath) {
      error('spawnChild: no server entry path resolved; cannot start local server')
      this.reportOffline('server entry not found')
      return
    }

    // ION_SUPERVISOR_PID lets the child notice this process is gone and exit
    // on its own (server/src/parent-watchdog.ts): the backstop for any exit
    // path that fails to stop() it, so an orphan can never again keep
    // studio.sock away from the next desktop's server.
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ION_SUPERVISOR_PID: String(process.pid),
      // The Visualizer theme packs this app ships. The server serves them
      // through `studio.listThemes`/`studio.readThemeBundle`/
      // `studio.readThemeAsset`; as a plain Node process it cannot read
      // inside app.asar, which is why `resources/studio` is asar-unpacked.
      ION_STUDIO_THEMES_BUNDLED_DIR: resolveBundledThemesDir(),
      // This server is the desktop owner's own install: every device they
      // pair is theirs, so it sees their conversations and administers the
      // install. The server only moves its DEFAULTS on this; a server.json
      // in the data dir still decides.
      ION_STUDIO_PROFILE: 'personal',
    } as NodeJS.ProcessEnv
    delete env.ION_STUDIO_LOCAL_ONLY
    if (this.dataDir) env.ION_DATA_DIR = this.dataDir
    if (this.hostAppVersion) env.ION_HOST_APP_VERSION = this.hostAppVersion

    log('spawning local server', { entry_path: this.entryPath, data_dir: this.dataDir ?? '(default)' })
    let child: ChildProcess
    try {
      child = this.spawnFn(process.execPath, [this.entryPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      error('spawnChild: spawn() threw', { error: (err as Error).message })
      this.handleExit(null, `spawn failed: ${(err as Error).message}`)
      return
    }
    this.child = child
    log('local server spawned', { pid: child.pid ?? 0, supervisor_pid: process.pid })

    // The server logs to its own file; the only thing that reaches these pipes
    // is what its logger could NOT write -- a crash's stack trace, an
    // unwritable log file. So stderr is a warning here, not a debug detail:
    // at any level above DEBUG the one record of a server crash used to be
    // discarded on its way into desktop.jsonl.
    const stdoutBuf = new LineBuffer((line) => debug('local server stdout', { line }))
    const stderrBuf = new LineBuffer((line) => {
      this.recentStderr.push(line)
      if (this.recentStderr.length > STDERR_TAIL_LINES) this.recentStderr.shift()
      warn('local server stderr', { line })
    })
    child.stdout?.on('data', (d: Buffer) => stdoutBuf.push(d))
    child.stderr?.on('data', (d: Buffer) => stderrBuf.push(d))

    // 'close' rather than 'exit': 'exit' fires while the pipes may still hold
    // unread bytes, so flushing there dropped the tail of a crash -- the part
    // naming the error -- and left the exit line with nothing to report.
    child.once('close', (code, signal) => {
      stdoutBuf.flush()
      stderrBuf.flush()
      if (this.child === child) this.child = null
      const reason = signal ? `signal ${signal}` : `exit code ${code}`
      this.handleExit(code, reason)
    })
    child.once('error', (err) => {
      stdoutBuf.flush()
      stderrBuf.flush()
      if (this.child === child) this.child = null
      this.handleExit(null, `spawn error: ${err.message}`)
    })
  }

  private handleExit(code: number | null, reason: string): void {
    if (this.stoppedByUser) {
      log('local server exited after a deliberate stop; not respawning', { code, reason })
      return
    }
    const now = Date.now()
    if (now - this.windowStartMs > RESPAWN_WINDOW_MS) {
      this.windowStartMs = now
      this.attempts = 0
    }
    this.attempts += 1
    // The tail travels with the exit, so one line says both that the server
    // died and what it said on the way out.
    warn('local server exited', {
      code,
      reason,
      attempt: this.attempts,
      max_attempts: MAX_ATTEMPTS,
      stderr_tail: this.recentStderr.join('\n'),
      stderr_tail_lines: this.recentStderr.length,
    })
    this.recentStderr = []

    if (this.attempts > MAX_ATTEMPTS) {
      this.reportOffline(reason)
      return
    }
    const delay = RESPAWN_LADDER_MS[Math.min(this.attempts - 1, RESPAWN_LADDER_MS.length - 1)]
    log('scheduling local server respawn', { attempt: this.attempts, delay_ms: delay })
    this.retryTimer = setTimeout(() => this.spawnChild(), delay)
  }

  private reportOffline(reason: string): void {
    error('local server respawn ladder exhausted; reporting offline', { reason, max_attempts: MAX_ATTEMPTS, window_ms: RESPAWN_WINDOW_MS })
    this.emit('offline', reason)
  }
}
