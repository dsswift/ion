/**
 * Which entries of a directory carry the Windows hidden attribute.
 *
 * Windows paths have no leading dot: AppData, ProgramData, and the legacy
 * junctions are marked by the attribute alone, and Node's `fs` exposes no
 * file attributes. The answer therefore comes from PowerShell, through ONE
 * long-lived helper process that answers a request per line.
 *
 * A process per listing is what this replaces. Starting PowerShell costs
 * hundreds of milliseconds, a listing is asked for per open folder, and the
 * call was synchronous, so every listing stopped the event loop for the
 * length of a PowerShell start.
 *
 * Both directions of the pipe carry base64 only. The console code page
 * decides how PowerShell decodes and encodes raw text, and a name outside
 * that code page would otherwise arrive as a different name.
 *
 * A failure resolves to an empty set rather than rejecting: losing the
 * dimming on a directory is a cosmetic degradation, while failing the
 * listing would empty the tree.
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'
import { log as _log, debug as _debug, warn as _warn } from '../logger'

const TAG = 'hidden-attribute-probe'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function debug(msg: string, fields?: Record<string, unknown>): void { _debug(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Longest a single answer is waited for before the listing goes ahead without it. */
export const PROBE_REQUEST_TIMEOUT_MS = 5_000
/** The helper exits after this long with nothing asked of it. */
export const PROBE_IDLE_EXIT_MS = 10 * 60_000
/** Shortest gap between two helper starts, so a helper that cannot run is not restarted per listing. */
export const PROBE_RESTART_GAP_MS = 5_000

/**
 * The helper's whole program. One request per line, `<id> <base64 path>`;
 * one answer per line, `<id> ok <base64 names joined by LF>` or
 * `<id> err <base64 message>`. Written for Windows PowerShell 5.1, which is
 * what `powershell.exe` is on every supported Windows.
 */
export const PROBE_SCRIPT = [
  '$utf8 = New-Object System.Text.UTF8Encoding($false)',
  '$stdin = [Console]::In',
  '$stdout = [Console]::Out',
  'while ($true) {',
  '  $line = $stdin.ReadLine()',
  '  if ($null -eq $line) { break }',
  "  $parts = $line.Split(' ')",
  '  if ($parts.Length -lt 2) { continue }',
  '  $id = $parts[0]',
  '  try {',
  '    $dir = $utf8.GetString([Convert]::FromBase64String($parts[1]))',
  '    $info = New-Object System.IO.DirectoryInfo($dir)',
  '    $names = New-Object System.Collections.Generic.List[string]',
  '    foreach ($entry in $info.GetFileSystemInfos()) {',
  '      if (($entry.Attributes -band [System.IO.FileAttributes]::Hidden) -ne 0) { $names.Add($entry.Name) }',
  '    }',
  '    $body = [Convert]::ToBase64String($utf8.GetBytes([string]::Join("`n", $names.ToArray())))',
  '    $stdout.WriteLine("$id ok $body")',
  '  } catch {',
  '    $body = [Convert]::ToBase64String($utf8.GetBytes($_.Exception.Message))',
  '    $stdout.WriteLine("$id err $body")',
  '  }',
  '  $stdout.Flush()',
  '}',
].join('\n')

export interface HiddenAttributeProbe {
  /** Names in `directory` that carry the hidden attribute. Never rejects. */
  hiddenNames(directory: string): Promise<Set<string>>
  /** Stop the helper and answer everything still waiting with an empty set. */
  dispose(): void
}

export interface HiddenAttributeProbeDeps {
  platform?: NodeJS.Platform
  /** The PowerShell executable. */
  shell?: string
  spawn?: typeof nodeSpawn
  requestTimeoutMs?: number
  idleExitMs?: number
  restartGapMs?: number
  now?: () => number
}

interface Pending {
  directory: string
  resolve: (names: Set<string>) => void
  timer: ReturnType<typeof setTimeout>
  startedAt: number
}

export function createHiddenAttributeProbe(deps: HiddenAttributeProbeDeps = {}): HiddenAttributeProbe {
  const platform = deps.platform ?? process.platform
  const shell = deps.shell ?? 'powershell.exe'
  const spawn = deps.spawn ?? nodeSpawn
  const requestTimeoutMs = deps.requestTimeoutMs ?? PROBE_REQUEST_TIMEOUT_MS
  const idleExitMs = deps.idleExitMs ?? PROBE_IDLE_EXIT_MS
  const restartGapMs = deps.restartGapMs ?? PROBE_RESTART_GAP_MS
  const now = deps.now ?? Date.now

  let helper: ChildProcessWithoutNullStreams | null = null
  let lastStartAt = -Infinity
  let nextId = 1
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const pending = new Map<string, Pending>()

  function settle(id: string, names: Set<string>): void {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(names)
  }

  function settleAll(reason: string): void {
    if (pending.size > 0) warn('answering waiting requests with no hidden names', { reason, waiting: pending.size })
    for (const id of [...pending.keys()]) settle(id, new Set())
  }

  function armIdleExit(): void {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (!helper || pending.size > 0) return
      log('helper idle, stopping it', { idle_ms: idleExitMs })
      stop(helper)
    }, idleExitMs)
    idleTimer.unref?.()
  }

  /** Closing stdin ends the helper's read loop, which is how it exits cleanly. */
  function stop(child: ChildProcessWithoutNullStreams): void {
    if (helper === child) helper = null
    child.stdin.end()
  }

  function onAnswer(line: string): void {
    const [id, status, body = ''] = line.trim().split(' ')
    const entry = pending.get(id)
    if (!entry) {
      debug('answer for a request that is no longer waiting', { id })
      return
    }
    const text = Buffer.from(body, 'base64').toString('utf-8')
    if (status !== 'ok') {
      debug('directory could not be probed; entries render unhidden', { directory: entry.directory, error: text })
      settle(id, new Set())
      return
    }
    const names = new Set(text.split('\n').filter(Boolean))
    debug('directory probed', { directory: entry.directory, hidden: names.size, duration_ms: now() - entry.startedAt })
    settle(id, names)
  }

  function start(): ChildProcessWithoutNullStreams | null {
    const at = now()
    if (at - lastStartAt < restartGapMs) {
      debug('helper start skipped, the last start was too recent', { since_last_start_ms: at - lastStartAt })
      return null
    }
    lastStartAt = at
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(
        shell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PROBE_SCRIPT, 'utf16le').toString('base64')],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )
    } catch (err) {
      warn('helper could not be started', { shell, error: String(err) })
      return null
    }
    // The helper must never be what keeps this process alive.
    child.unref()
    for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as { unref?: () => void }).unref?.()

    createInterface({ input: child.stdout }).on('line', onAnswer)
    child.stderr.on('data', (chunk: Buffer) => debug('helper stderr', { text: chunk.toString('utf-8').slice(0, 500) }))
    child.stdin.on('error', (err) => debug('helper stdin errored', { error: String(err) }))
    child.on('error', (err) => {
      warn('helper errored', { shell, error: String(err) })
      if (helper === child) helper = null
      settleAll('helper errored')
    })
    child.on('exit', (code, signal) => {
      log('helper exited', { code, signal })
      if (helper === child) {
        helper = null
        settleAll('helper exited')
      }
    })
    log('helper started', { shell, pid: child.pid })
    return child
  }

  return {
    hiddenNames(directory: string): Promise<Set<string>> {
      if (platform !== 'win32') return Promise.resolve(new Set())
      helper ??= start()
      const child = helper
      if (!child) return Promise.resolve(new Set())
      return new Promise((resolve) => {
        const id = String(nextId++)
        const timer = setTimeout(() => {
          warn('no answer in time; entries render unhidden', { directory, timeout_ms: requestTimeoutMs })
          settle(id, new Set())
        }, requestTimeoutMs)
        pending.set(id, { directory, resolve, timer, startedAt: now() })
        child.stdin.write(`${id} ${Buffer.from(directory, 'utf-8').toString('base64')}\n`)
        armIdleExit()
      })
    },

    dispose(): void {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = null
      const child = helper
      if (child) stop(child)
      settleAll('probe disposed')
    },
  }
}

/** The probe every listing shares. */
export const hiddenAttributeProbe: HiddenAttributeProbe = createHiddenAttributeProbe()
