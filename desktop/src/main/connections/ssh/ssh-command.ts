/**
 * ssh-command -- one way to run the system `ssh` for the SSH door.
 *
 * Every SSH invocation the desktop makes (the platform probe, the piped
 * installer, the pairing-link mint, the port forward) goes through here so
 * the argv is built in one place and a failure is classified once:
 *
 *  - `auth_required`: BatchMode refused a password/passphrase prompt. Key
 *    auth is the requirement; the message says so.
 *  - `host_unreachable`: name resolution, connection refused, timeout.
 *  - `remote_failed`: the remote command itself exited non-zero.
 *
 * `BatchMode=yes` is deliberate. There is no terminal to prompt on, and a
 * hung prompt is indistinguishable from a hung host; a refusal with the
 * exact fix (`ssh-copy-id`) is better than either.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'child_process'
import { log as _log, warn as _warn } from '../../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('ssh-command', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('ssh-command', msg, fields)
}

/** Injectable for tests: the shape of `child_process.spawn` this module uses. */
export type SshSpawn = (command: string, args: string[], options: { stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcess

export interface SshDestination {
  /** `[user@]host` or an ssh_config alias. */
  destination: string
  port?: number
}

export type SshFailureKind = 'auth_required' | 'host_unreachable' | 'remote_failed' | 'spawn_failed'

export class SshError extends Error {
  constructor(readonly kind: SshFailureKind, message: string, readonly exitCode: number | null = null) {
    super(message)
    this.name = 'SshError'
  }
}

/**
 * Parses what the operator typed into a destination and optional port:
 * `host`, `user@host`, `user@host:2222`, `ssh://user@host:2222`, or an
 * ssh_config alias. Returns null for an empty or malformed value.
 */
export function parseSshDestination(input: string): SshDestination | null {
  let s = input.trim()
  if (!s) return null
  if (s.startsWith('ssh://')) s = s.slice('ssh://'.length)
  s = s.replace(/\/+$/, '')
  if (/\s/.test(s)) return null
  const m = /^(.*?)(?::(\d{1,5}))?$/.exec(s)
  if (!m) return null
  const destination = m[1]
  if (!destination || destination.startsWith('-')) return null
  const port = m[2] ? Number(m[2]) : undefined
  if (port !== undefined && (port < 1 || port > 65535)) return null
  return port === undefined ? { destination } : { destination, port }
}

/**
 * The options every invocation carries: no prompts, bounded connect,
 * keepalives that notice a dead peer within a minute, and no post-quantum
 * advisory. `tool` picks the port flag: `ssh` takes `-p`, `scp` takes `-P`.
 */
export function sshBaseArgs(dest: SshDestination, tool: 'ssh' | 'scp' = 'ssh'): string[] {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    // A first connection to a host the operator just typed must not hang on
    // a fingerprint prompt (BatchMode would refuse it anyway); accept and
    // record a new key, still refuse a CHANGED one.
    '-o', 'StrictHostKeyChecking=accept-new',
    // OpenSSH 10 prints a four-line "not using a post-quantum key exchange"
    // advisory on stderr for any older host. It is not a failure, and every
    // stderr line lands in the operator's progress list and in the error
    // shown when a remote command fails, where it buries the real reason.
    // WarnWeakCrypto turns it off; IgnoreUnknown (in front of it) keeps an
    // older ssh that has no such option from refusing the whole command.
    '-o', 'IgnoreUnknown=WarnWeakCrypto',
    '-o', 'WarnWeakCrypto=no',
  ]
  if (dest.port !== undefined) args.push(tool === 'scp' ? '-P' : '-p', String(dest.port))
  return args
}

/** Maps ssh's exit code and stderr onto a failure kind and an operator-facing message. */
export function classifySshFailure(dest: SshDestination, exitCode: number | null, stderr: string): SshError {
  const tail = stderr.trim().split('\n').slice(-5).join('\n')
  const where = dest.port !== undefined ? `${dest.destination}:${dest.port}` : dest.destination
  if (/Permission denied|Host key verification failed|Too many authentication failures|no such identity/i.test(stderr)) {
    return new SshError('auth_required',
      `SSH to ${where} needs key-based authentication (no password prompt is possible here). ` +
      `Add your key with: ssh-copy-id ${where}\n${tail}`, exitCode)
  }
  if (exitCode === 255 || /Could not resolve hostname|Connection refused|Connection timed out|No route to host|Network is unreachable|Operation timed out/i.test(stderr)) {
    return new SshError('host_unreachable', `Could not reach ${where} over SSH.\n${tail}`, exitCode)
  }
  return new SshError('remote_failed', `The command on ${where} failed (exit ${exitCode ?? 'signal'}).\n${tail}`, exitCode)
}

export interface RunSshOptions {
  dest: SshDestination
  /** The remote command line, run by the login shell on the host. */
  command: string
  /** Bytes to feed the remote command's stdin (the piped installer). */
  stdin?: string
  /** Called for every complete stdout line as it arrives. */
  onStdoutLine?: (line: string) => void
  /** Called for every complete stderr line as it arrives. */
  onStderrLine?: (line: string) => void
  spawn?: SshSpawn
}

export interface RunSshResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Splits arbitrary chunk boundaries into whole lines for the line callbacks. */
class LineSplitter {
  private carry = ''
  constructor(private readonly onLine: (line: string) => void) {}
  push(chunk: Buffer): void {
    const text = this.carry + chunk.toString('utf-8')
    const lines = text.split('\n')
    this.carry = lines.pop() ?? ''
    for (const line of lines) this.onLine(line)
  }
  flush(): void {
    if (this.carry) this.onLine(this.carry)
    this.carry = ''
  }
}

/**
 * Runs one remote command and resolves with its output, or rejects with a
 * classified `SshError`. Never resolves on a non-zero exit: the caller
 * always sees a typed failure.
 */
export function runSsh(opts: RunSshOptions): Promise<RunSshResult> {
  const spawn = opts.spawn ?? (nodeSpawn as unknown as SshSpawn)
  const args = [...sshBaseArgs(opts.dest), opts.dest.destination, opts.command]
  log('ssh run', { destination: opts.dest.destination, port: opts.dest.port, command_head: opts.command.slice(0, 80), stdin_bytes: opts.stdin?.length ?? 0 })
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      reject(new SshError('spawn_failed', `Could not start ssh: ${err instanceof Error ? err.message : String(err)}`))
      return
    }
    let stdout = ''
    let stderr = ''
    const outLines = new LineSplitter((line) => opts.onStdoutLine?.(line))
    const errLines = new LineSplitter((line) => {
      // ssh's own advisories (a post-quantum notice on newer OpenSSH) are
      // not the remote command's output; keep them out of the operator's view.
      if (/post-quantum|store now, decrypt later|openssh\.com\/pq/i.test(line)) return
      opts.onStderrLine?.(line)
    })
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); outLines.push(chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); errLines.push(chunk) })
    child.on('error', (err) => {
      warn('ssh spawn error', { destination: opts.dest.destination, error: err.message })
      reject(new SshError('spawn_failed', `Could not start ssh: ${err.message}`))
    })
    child.on('close', (code) => {
      outLines.flush()
      errLines.flush()
      if (code === 0) {
        log('ssh run completed', { destination: opts.dest.destination, stdout_bytes: stdout.length })
        resolve({ stdout, stderr, exitCode: 0 })
        return
      }
      const failure = classifySshFailure(opts.dest, code, stderr)
      warn('ssh run failed', { destination: opts.dest.destination, exit_code: code, kind: failure.kind })
      reject(failure)
    })
    if (opts.stdin !== undefined) child.stdin?.end(opts.stdin)
    else child.stdin?.end()
  })
}
