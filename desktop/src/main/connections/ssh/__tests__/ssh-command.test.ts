/**
 * ssh-command -- destination parsing, the batch argv every invocation
 * carries, and failure classification. The spawn is faked so the classifier
 * is exercised on real stderr shapes without an ssh binary.
 */
import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcess } from 'child_process'
import { parseSshDestination, sshBaseArgs, classifySshFailure, runSsh, SshError, type SshSpawn } from '../ssh-command'

function fakeChild(script: { stdout?: string; stderr?: string; code: number }): { child: ChildProcess; argv: string[] } {
  const child = new EventEmitter() as ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  setTimeout(() => {
    if (script.stdout) child.stdout.write(script.stdout)
    if (script.stderr) child.stderr.write(script.stderr)
    child.stdout.end()
    child.stderr.end()
    child.emit('close', script.code, null)
  }, 0)
  return { child, argv: [] }
}

function spawnScript(script: { stdout?: string; stderr?: string; code: number }, seen: string[][]): SshSpawn {
  return (_cmd, args) => {
    seen.push(args)
    return fakeChild(script).child
  }
}

describe('parseSshDestination', () => {
  it('accepts host, user@host, host:port, and ssh:// forms', () => {
    expect(parseSshDestination('grover.local')).toEqual({ destination: 'grover.local' })
    expect(parseSshDestination('josh@grover.local')).toEqual({ destination: 'josh@grover.local' })
    expect(parseSshDestination('josh@grover.local:2222')).toEqual({ destination: 'josh@grover.local', port: 2222 })
    expect(parseSshDestination('ssh://josh@grover.local:2222/')).toEqual({ destination: 'josh@grover.local', port: 2222 })
    expect(parseSshDestination('  lab  ')).toEqual({ destination: 'lab' })
  })

  it('refuses empty, spaced, option-like, and out-of-range values', () => {
    expect(parseSshDestination('')).toBeNull()
    expect(parseSshDestination('a b')).toBeNull()
    expect(parseSshDestination('-oProxyCommand=x')).toBeNull()
    expect(parseSshDestination('host:70000')).toBeNull()
  })
})

describe('sshBaseArgs', () => {
  it('never prompts, bounds the connect, keeps the peer alive, and carries the port', () => {
    const args = sshBaseArgs({ destination: 'h', port: 2222 })
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('ConnectTimeout=15')
    expect(args).toContain('ServerAliveInterval=15')
    expect(args).toContain('StrictHostKeyChecking=accept-new')
    expect(args.slice(-2)).toEqual(['-p', '2222'])
    expect(sshBaseArgs({ destination: 'h' })).not.toContain('-p')
  })

  it('silences the OpenSSH 10 post-quantum advisory, behind IgnoreUnknown so an older ssh still accepts the argv', () => {
    const args = sshBaseArgs({ destination: 'h' })
    const ignore = args.indexOf('IgnoreUnknown=WarnWeakCrypto')
    const off = args.indexOf('WarnWeakCrypto=no')
    expect(ignore).toBeGreaterThan(-1)
    expect(off).toBeGreaterThan(ignore)
  })

  it('uses -P for scp and -p for ssh', () => {
    expect(sshBaseArgs({ destination: 'h', port: 2222 }, 'scp')).toContain('-P')
    expect(sshBaseArgs({ destination: 'h', port: 2222 }, 'scp')).not.toContain('-p')
    expect(sshBaseArgs({ destination: 'h', port: 2222 })).toContain('-p')
  })
})

describe('classifySshFailure', () => {
  it('names key auth with the ssh-copy-id fix on a permission denial', () => {
    const err = classifySshFailure({ destination: 'josh@h' }, 255, 'josh@h: Permission denied (publickey,password).')
    expect(err.kind).toBe('auth_required')
    expect(err.message).toContain('ssh-copy-id josh@h')
  })

  it('classifies unreachable hosts and remote command failures apart', () => {
    expect(classifySshFailure({ destination: 'h' }, 255, 'ssh: Could not resolve hostname h').kind).toBe('host_unreachable')
    expect(classifySshFailure({ destination: 'h' }, 1, 'install-studio-server: checksum mismatch').kind).toBe('remote_failed')
    expect(classifySshFailure({ destination: 'h', port: 22 }, 1, 'x').message).toContain('h:22')
  })
})

describe('runSsh', () => {
  it('builds the argv from the base options, the destination, and the command, and feeds stdin', async () => {
    const seen: string[][] = []
    let fed = ''
    const spawn: SshSpawn = (_cmd, args) => {
      seen.push(args)
      const { child } = fakeChild({ stdout: 'a\nb\n', code: 0 })
      ;(child.stdin as PassThrough).on('data', (c: Buffer) => { fed += c.toString() })
      return child
    }
    const lines: string[] = []
    const result = await runSsh({ dest: { destination: 'josh@h', port: 2222 }, command: 'sh -s', stdin: 'echo hi\n', onStdoutLine: (l) => lines.push(l), spawn })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('a\nb\n')
    expect(lines).toEqual(['a', 'b'])
    expect(fed).toBe('echo hi\n')
    expect(seen[0].slice(-2)).toEqual(['josh@h', 'sh -s'])
    expect(seen[0]).toContain('-p')
  })

  it('rejects with a classified SshError on a non-zero exit and filters ssh advisories from stderr lines', async () => {
    const seen: string[][] = []
    const errLines: string[] = []
    await expect(runSsh({
      dest: { destination: 'h' },
      command: 'true',
      onStderrLine: (l) => errLines.push(l),
      spawn: spawnScript({ stderr: 'post-quantum advisory here\nh: Permission denied (publickey).\n', code: 255 }, seen),
    })).rejects.toSatisfy((err: unknown) => err instanceof SshError && err.kind === 'auth_required')
    expect(errLines).toEqual(['h: Permission denied (publickey).'])
  })
})
