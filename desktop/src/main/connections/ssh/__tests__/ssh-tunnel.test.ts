/**
 * ssh-tunnel -- one forward per key: `ensure` reserves a port, spawns
 * `ssh -N -L`, waits for the probe, shares an in-flight start, keeps the
 * same local port across a dropped-and-respawned forward, and stops cleanly.
 */
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import type { ChildProcess } from 'child_process'
import { SshTunnelManager, TUNNEL_RESTART_LADDER_MS } from '../ssh-tunnel'
import type { SshSpawn } from '../ssh-command'

interface FakeProc extends EventEmitter {
  stdin: PassThrough
  stderr: PassThrough
  exitCode: number | null
  killed: boolean
  kill(): boolean
  args: string[]
}

function makeSpawner(): { spawn: SshSpawn; procs: FakeProc[] } {
  const procs: FakeProc[] = []
  const spawn: SshSpawn = (_cmd, args) => {
    const proc = new EventEmitter() as FakeProc
    proc.stdin = new PassThrough()
    proc.stderr = new PassThrough()
    proc.exitCode = null
    proc.killed = false
    proc.args = args
    proc.kill = () => { proc.killed = true; proc.exitCode = 0; setTimeout(() => proc.emit('close', 0, null), 0); return true }
    procs.push(proc)
    return proc as unknown as ChildProcess
  }
  return { spawn, procs }
}

const leg = { destination: 'josh@oscar.local', remotePort: 7331 }

describe('SshTunnelManager', () => {
  it('reserves a port, spawns the forward with -N -L to the remote port, and resolves when the probe answers', async () => {
    const { spawn, procs } = makeSpawner()
    let probes = 0
    const m = new SshTunnelManager({ spawn, reservePort: async () => 45000, probe: async () => ++probes >= 2, setTimeoutFn: ((fn: () => void) => setTimeout(fn, 0)) as unknown as typeof setTimeout })
    const handle = await m.ensure('env-1', leg)
    expect(handle.localPort).toBe(45000)
    expect(procs).toHaveLength(1)
    expect(procs[0].args).toContain('-N')
    expect(procs[0].args).toContain('ExitOnForwardFailure=yes')
    expect(procs[0].args).toContain('-L')
    expect(procs[0].args[procs[0].args.indexOf('-L') + 1]).toBe('127.0.0.1:45000:127.0.0.1:7331')
    expect(procs[0].args.at(-1)).toBe('josh@oscar.local')
    expect(m.localPortOf('env-1')).toBe(45000)
  })

  it('shares an in-flight start and reuses a live forward', async () => {
    const { spawn, procs } = makeSpawner()
    const m = new SshTunnelManager({ spawn, reservePort: async () => 45001, probe: async () => true })
    const [a, b] = await Promise.all([m.ensure('env-1', leg), m.ensure('env-1', leg)])
    expect(a.localPort).toBe(b.localPort)
    expect(procs).toHaveLength(1)
    await m.ensure('env-1', leg)
    expect(procs).toHaveLength(1)
  })

  it('respawns a dropped forward on the same port after the ladder delay', async () => {
    const { spawn, procs } = makeSpawner()
    const delays: number[] = []
    const timers: Array<() => void> = []
    const setTimeoutFn = ((fn: () => void, ms: number) => { delays.push(ms); timers.push(fn); return 0 as unknown as ReturnType<typeof setTimeout> }) as unknown as typeof setTimeout
    const m = new SshTunnelManager({ spawn, reservePort: async () => 45002, probe: async () => true, setTimeoutFn })
    await m.ensure('env-1', leg)
    procs[0].exitCode = 255
    procs[0].emit('close', 255, null)
    expect(delays.at(-1)).toBe(TUNNEL_RESTART_LADDER_MS[0])
    timers.at(-1)?.()
    expect(procs).toHaveLength(2)
    expect(procs[1].args[procs[1].args.indexOf('-L') + 1]).toBe('127.0.0.1:45002:127.0.0.1:7331')
    expect(m.localPortOf('env-1')).toBe(45002)
  })

  it('rejects when the forward exits before the server answers', async () => {
    const { spawn, procs } = makeSpawner()
    const m = new SshTunnelManager({ spawn, reservePort: async () => 45003, probe: async () => { procs[0].exitCode = 255; return false }, setTimeoutFn: ((fn: () => void) => setTimeout(fn, 0)) as unknown as typeof setTimeout })
    await expect(m.ensure('env-1', leg)).rejects.toThrow(/exited with 255/)
  })

  it('stop kills the process, cancels a pending restart, and rekey moves an entry', async () => {
    const { spawn, procs } = makeSpawner()
    const m = new SshTunnelManager({ spawn, reservePort: async () => 45004, probe: async () => true })
    await m.ensure('ssh:josh@oscar.local', leg)
    m.rekey('ssh:josh@oscar.local', 'env-9')
    expect(m.localPortOf('env-9')).toBe(45004)
    expect(m.localPortOf('ssh:josh@oscar.local')).toBeNull()
    m.stop('env-9')
    expect(procs[0].killed).toBe(true)
    expect(m.localPortOf('env-9')).toBeNull()
    await new Promise((r) => setTimeout(r, 5))
    expect(procs).toHaveLength(1)
    const spy = vi.fn()
    m.stopAll()
    expect(spy).not.toHaveBeenCalled()
  })
})
