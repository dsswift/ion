/**
 * terminal-api — the terminal and bash verbs, headless.
 *
 * The PTY manager already lived in this package
 * (`terminal/terminal-manager.ts`), and its output already reaches every
 * Studio client: `TERMINAL_INCOMING` / `TERMINAL_EXIT` / `TERMINAL_ACTIVITY`
 * go through the server's `broadcast()`, all three channels are registered
 * in `EVENT_CHANNELS`, and `events.ts` resolves a tab id from the terminal
 * key so a client only sees terminals for tabs it owns.
 *
 * What was missing was the COMMAND half. Create, write, resize, destroy, and
 * attach sat behind `ipcMain` in `desktop/src/main/ipc/terminal.ts`, so a
 * browser Studio client could receive terminal output it had no way to ask
 * for and no way to type into -- which is why the surface tab reported
 * "Terminal is not available in the browser" rather than degrading.
 *
 * The Electron adapter's resize arbitration (dropping a resize from a hidden
 * BrowserWindow) went with that adapter: the desktop no longer registers
 * terminal IPC at all. What guards the PTY against a hidden or collapsed
 * viewer's measurement is `TerminalManager.resize`'s plausibility check,
 * which holds for every client rather than only an Electron window.
 */
import { spawn } from 'child_process'
import { terminalManager } from './terminal-manager-instance'
import { restoredStudioExitCodes } from '../persistence/studio-terminal-persistence'
import { bashProcesses, sessionPlane } from '../state'
import { getCliEnv } from '../cli-env'
import { log as _log } from '../logger'
import { commandShell } from './terminal-shell'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('terminal-api', msg, fields)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export function terminalCreate(payload: unknown): void {
  const key = str((payload as { key?: unknown } | null)?.key)
  const cwd = str((payload as { cwd?: unknown } | null)?.cwd)
  if (!key) return
  log('terminal_create', { key, cwd })
  terminalManager.create(key, cwd)
}

export function terminalWrite(payload: unknown): void {
  const key = str((payload as { key?: unknown } | null)?.key)
  const data = str((payload as { data?: unknown } | null)?.data)
  if (!key) return
  terminalManager.write(key, data)
}

export function terminalResize(payload: unknown): void {
  const key = str((payload as { key?: unknown } | null)?.key)
  const cols = num((payload as { cols?: unknown } | null)?.cols)
  const rows = num((payload as { rows?: unknown } | null)?.rows)
  if (!key || cols <= 0 || rows <= 0) return
  terminalManager.resize(key, cols, rows)
}

export function terminalDestroy(payload: unknown): void {
  const key = str((payload as { key?: unknown } | null)?.key)
  if (!key) return
  log('terminal_destroy', { key })
  terminalManager.destroy(key)
}

export function terminalActiveTabs(): unknown {
  return terminalManager.activeTabIds()
}

export function terminalActivitySnapshot(): unknown {
  return terminalManager.activitySnapshot()
}

/**
 * The attach protocol: one call returns `{history, running, exitCode, cwd,
 * cwdFellBack}` and the caller then rides the live output stream.
 * `restartIfNotRunning` respawns a dead terminal on demand (a dead cwd falls
 * back to `~`, reported via `cwdFellBack` so the client can say so).
 */
export function terminalAttach(payload: unknown): unknown {
  const p = (payload ?? {}) as { key?: unknown; restartIfNotRunning?: unknown; cwd?: unknown }
  const key = str(p.key)
  if (!key) return { history: '', running: false, exitCode: null, cwd: '', cwdFellBack: false, startError: null }
  const restartIfNotRunning = p.restartIfNotRunning === true
  const info = terminalManager.attach(key, {
    restartIfNotRunning,
    ...(typeof p.cwd === 'string' ? { cwd: p.cwd } : {}),
  })
  // A terminal restored from disk (app restart) has history but no manager
  // lifecycle until it respawns; report its persisted exit code so the client
  // renders the exited state instead of "running".
  if (!info.running && info.exitCode === null && restoredStudioExitCodes.has(key)) {
    info.exitCode = restoredStudioExitCodes.get(key) ?? null
  }
  log('terminal_attach', {
    key, running: info.running, exit_code: info.exitCode ?? '',
    history_bytes: info.history.length, restart: restartIfNotRunning, cwd_fell_back: info.cwdFellBack,
    start_error: info.startError ?? '',
  })
  return info
}

export interface BashResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

/** Run one shell command to completion, capturing both streams. */
export function executeBash(payload: unknown): Promise<BashResult> {
  const p = (payload ?? {}) as { id?: unknown; command?: unknown; cwd?: unknown }
  const id = str(p.id)
  const command = str(p.command)
  const cwd = str(p.cwd)
  log('execute_bash', { id, command, cwd })
  return new Promise<BashResult>((resolve) => {
    if (!id || !command) {
      resolve({ stdout: '', stderr: 'id and command are required', exitCode: 1 })
      return
    }
    const runner = commandShell(command)
    const child = spawn(runner.shell, runner.args, { cwd: cwd || undefined, env: getCliEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    bashProcesses.set(id, child)

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout!.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr!.on('data', (chunk: Buffer) => stderrChunks.push(chunk))

    child.on('close', (code) => {
      bashProcesses.delete(id)
      sessionPlane.notifyExternalWorkDone()
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        exitCode: code,
      })
    })

    child.on('error', (err) => {
      bashProcesses.delete(id)
      sessionPlane.notifyExternalWorkDone()
      resolve({ stdout: '', stderr: err.message, exitCode: 1 })
    })
  })
}

export function cancelBash(payload: unknown): void {
  const id = typeof payload === 'string' ? payload : str((payload as { id?: unknown } | null)?.id)
  const child = bashProcesses.get(id)
  if (!child) return
  log('cancel_bash: sending SIGINT', { id })
  child.kill('SIGINT')
}
