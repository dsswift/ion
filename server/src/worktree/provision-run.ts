/**
 * Command execution for worktree provisioning (`build` and `setup`).
 *
 * ── What runs here ──────────────────────────────────────────────────────────
 * Project-authored commands from `.ion/worktree.json`: `npm ci`, `go mod
 * download`, `make bootstrap`, and whatever a future ecosystem needs. Ion runs
 * what the manifest declares, in the worktree, and captures the output.
 *
 * That is the same trust posture the repository already has for git hooks and
 * for `npm install`'s postinstall chain: a manifest is only ever read from a
 * repo the operator has already chosen to open. It is stated plainly rather
 * than implied, because "Ion executes a string from a file" deserves to be
 * visible in the code that does it.
 *
 * ── Why output is captured, not discarded ───────────────────────────────────
 * A failed `npm ci` is useless without its stderr. The whole point of the
 * `failed` provisioning state is that the operator can see WHY, so the tail of
 * combined output rides on the result and every run logs its outcome. A
 * provisioning failure that says only "failed" would be the silent-failure
 * anti-pattern with extra steps.
 *
 * ── Why a timeout ───────────────────────────────────────────────────────────
 * A hung install (dead registry, credential prompt on a TTY that does not
 * exist) must not pin a worktree in `building` forever. The process is killed
 * and reported as a failure the operator can retry.
 */
import { spawn } from 'child_process'
import { getCliEnv } from '../cli-env'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'worktree.provision'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Default ceiling for a single provisioning command. A cold `npm ci` on a big tree is minutes, not seconds. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60 * 1000

/** How much combined output to retain for the failure surface. */
const OUTPUT_TAIL_LIMIT = 8000

export interface RunResult {
  ok: boolean
  exitCode: number | null
  /** Tail of combined stdout+stderr, capped. Present on success and failure. */
  output: string
  /** Set when the command was killed for exceeding its timeout. */
  timedOut?: boolean
  /** Set when the command was killed because its run was cancelled. */
  cancelled?: boolean
  error?: string
}

/**
 * Kill the command and everything it started. The shell is only the parent:
 * `npm ci` and its compilers are its children, and killing the shell alone
 * leaves them writing into a worktree that is being removed. On POSIX the
 * shell leads its own process group (`detached`), so the group is signalled;
 * Windows has no groups, and `taskkill /T` walks the tree instead.
 */
function killTree(child: ReturnType<typeof spawn>, command: string): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
        .on('error', (err) => warn('taskkill failed', { command, pid, error: String(err) }))
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch (err) {
    warn('kill failed', { command, pid, error: String(err) })
  }
}

/**
 * Run `command` with the shell, in `cwd`.
 *
 * The shell is deliberate: manifest commands are written the way an operator
 * would type them (`npm ci`, `make bootstrap`), and may legitimately contain
 * pipes or `&&`. Splitting them into argv would break that and offer no safety
 * benefit — the command string is already fully trusted by the time it is read
 * from the project's own committed manifest.
 *
 * Never throws. A spawn failure resolves as `{ ok: false }` with the reason, so
 * callers handle one shape.
 */
export function runProvisionCommand(
  command: string,
  cwd: string,
  timeoutMs: number = DEFAULT_COMMAND_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const startedAt = Date.now()
    if (signal?.aborted) {
      log('provisioning command skipped, run cancelled', { command, cwd })
      resolve({ ok: false, exitCode: null, output: '', cancelled: true, error: 'cancelled' })
      return
    }
    log('running provisioning command', { command, cwd, timeout_ms: timeoutMs })

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        env: getCliEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so killTree reaches every descendant.
        detached: process.platform !== 'win32',
      })
    } catch (err) {
      warn('provisioning command failed to spawn', { command, cwd, error: String(err) })
      resolve({ ok: false, exitCode: null, output: '', error: String(err) })
      return
    }

    let output = ''
    let timedOut = false
    let cancelled = false
    const onAbort = (): void => {
      cancelled = true
      warn('provisioning command cancelled; killing', { command, cwd })
      killTree(child, command)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const append = (chunk: Buffer | string): void => {
      output += String(chunk)
      // Keep only the tail: a verbose install can emit megabytes, and only the
      // end is diagnostic.
      if (output.length > OUTPUT_TAIL_LIMIT) output = output.slice(-OUTPUT_TAIL_LIMIT)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    const timer = setTimeout(() => {
      timedOut = true
      warn('provisioning command timed out; killing', { command, cwd, timeout_ms: timeoutMs })
      killTree(child, command)
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      warn('provisioning command errored', { command, cwd, error: String(err) })
      resolve({ ok: false, exitCode: null, output, error: String(err) })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      const elapsedMs = Date.now() - startedAt
      const ok = code === 0 && !timedOut && !cancelled
      if (ok) {
        log('provisioning command succeeded', { command, cwd, elapsed_ms: elapsedMs })
      } else {
        warn('provisioning command failed', {
          command, cwd, exit_code: code, timed_out: timedOut, cancelled, elapsed_ms: elapsedMs,
          output_tail: output.slice(-1200),
        })
      }
      resolve({
        ok,
        exitCode: code,
        output,
        timedOut: timedOut || undefined,
        cancelled: cancelled || undefined,
        error: ok ? undefined : cancelled ? 'cancelled' : timedOut ? `timed out after ${timeoutMs}ms` : `exited ${code}`,
      })
    })
  })
}
