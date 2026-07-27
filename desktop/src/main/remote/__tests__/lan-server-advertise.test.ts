// Regression tests for the Bonjour advertisement lifecycle.
//
// Origin: the desktop stopped being discoverable on mDNS mid-session. The log
// showed `dns-sd exited signal=SIGTERM` with no respawn, and the SIGTERM came
// from the desktop's OWN test suite: LANServer.start() unconditionally
// advertised, and the orphan sweep matched `dns-sd -R .* _ion._tcp` — no port,
// unescaped `.` — so constructing a LANServer on any port killed the live
// app's registration. Nothing ever brought it back.
//
// Three behaviours are pinned here, each failing on the unfixed code:
//   1. advertise:false performs no mDNS side effects at all.
//   2. The orphan sweep is scoped to our own service name AND port.
//   3. An unexpected dns-sd exit respawns; an intentional stop does not.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import { hostname } from 'os'

vi.mock('../../logger', () => ({
  log: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
}))

const spawnMock = vi.fn()
const spawnSyncMock = vi.fn()

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}))

// Imported after the mocks so the module binds the mocked child_process.
const { LANServer } = await import('../lan-server')

const TEST_PORT = 47921
/** A dns-sd registration owned by some other process, on a different port. */
const FOREIGN_PID = 999_001

/** Minimal stand-in for the dns-sd ChildProcess. */
class FakeDnssd extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 4242
  kill = vi.fn(() => {
    this.emit('exit', null, 'SIGTERM')
    return true
  })
}

/** Every dns-sd spawn recorded by the mock, oldest first. */
function dnssdSpawns(): unknown[][] {
  return spawnMock.mock.calls.filter((call) => call[0] === '/usr/bin/dns-sd')
}

/**
 * Fake children handed out by the spawn mock, oldest first. Each spawn must
 * get its OWN emitter: the real spawn() returns a fresh ChildProcess every
 * time, so reusing one object across respawns would stack duplicate 'exit'
 * listeners and make a single emit fire the handler more than once.
 */
let children: FakeDnssd[] = []

/** The most recently spawned fake dns-sd child. */
function latestChild(): FakeDnssd {
  const child = children[children.length - 1]
  if (!child) throw new Error('no dns-sd child spawned')
  return child
}

/** The pgrep pattern from the Nth sweep call. */
function pgrepPattern(index = 0): string {
  const call = spawnSyncMock.mock.calls.filter((c) => c[0] === 'pgrep')[index]
  return (call?.[1] as string[])?.[1] ?? ''
}

describe('LANServer Bonjour advertisement', () => {
  let killSpy: ReturnType<typeof vi.spyOn>
  let servers: InstanceType<typeof LANServer>[]

  beforeEach(() => {
    vi.useFakeTimers()
    spawnMock.mockReset()
    spawnSyncMock.mockReset()
    servers = []
    children = []
    // Default: no stale registrations found.
    spawnSyncMock.mockReturnValue({ stdout: '', status: 1, error: undefined })
    spawnMock.mockImplementation(() => {
      const child = new FakeDnssd()
      children.push(child)
      return child
    })
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
  })

  afterEach(async () => {
    for (const server of servers) await server.stop()
    killSpy.mockRestore()
    vi.useRealTimers()
  })

  /** Start a LANServer and track it for teardown. */
  async function startServer(options: Record<string, unknown>) {
    const server = new LANServer({ port: TEST_PORT, ...options })
    servers.push(server)
    await server.start()
    return server
  }

  describe('advertise option', () => {
    it('performs no mDNS side effects when advertise is false', async () => {
      await startServer({ advertise: false })

      // No registration spawned, and — just as important — no orphan sweep,
      // which is what killed the live app's dns-sd from the test suite.
      expect(dnssdSpawns()).toHaveLength(0)
      expect(spawnSyncMock).not.toHaveBeenCalled()
      expect(killSpy).not.toHaveBeenCalled()
    })

    it('advertises by default', async () => {
      await startServer({})

      const spawns = dnssdSpawns()
      expect(spawns).toHaveLength(1)
      expect(spawns[0][1]).toEqual([
        '-R', hostname().replace(/\.local$/, ''), '_ion._tcp', 'local', String(TEST_PORT),
      ])
    })
  })

  describe('orphan sweep scoping', () => {
    it('scopes the pgrep pattern to our own service name, type and port', async () => {
      await startServer({})

      const pattern = pgrepPattern()
      // Port-scoped: a dns-sd on any other port is not a candidate.
      expect(pattern).toContain(`local ${TEST_PORT}`)
      // `.` escaped so it matches a literal dot, not any character.
      expect(pattern).toContain('_ion\\._tcp')
      expect(pattern).not.toContain('_ion._tcp')
      // The old pattern's wildcard between -R and the service type is gone.
      expect(pattern).not.toContain('-R .*')
      expect(pattern).toContain(hostname().replace(/\.local$/, ''))
    })

    it('does not shell out (no /bin/sh whose own cmdline matches the pattern)', async () => {
      await startServer({})

      const sweep = spawnSyncMock.mock.calls.find((c) => c[0] === 'pgrep')
      expect(sweep).toBeDefined()
      // argv form, not a shell string: pgrep is exec'd directly.
      expect(Array.isArray(sweep?.[1])).toBe(true)
      expect(spawnSyncMock.mock.calls.some((c) => String(c[0]).includes('sh'))).toBe(false)
    })

    it('kills a stale registration that pgrep reports for our own name and port', async () => {
      spawnSyncMock.mockReturnValue({ stdout: `${FOREIGN_PID}\n`, status: 0, error: undefined })

      await startServer({})

      // pgrep only reports processes matching the scoped pattern, so anything
      // it returns is a genuine orphan of this exact service.
      expect(killSpy).toHaveBeenCalledWith(FOREIGN_PID, 'SIGTERM')
    })

    it('survives a pgrep failure without aborting the advertisement', async () => {
      spawnSyncMock.mockReturnValue({ stdout: '', status: null, error: new Error('pgrep missing') })

      await startServer({})

      expect(killSpy).not.toHaveBeenCalled()
      // The sweep is best-effort; registration must still happen.
      expect(dnssdSpawns()).toHaveLength(1)
    })
  })

  describe('respawn after unexpected exit', () => {
    it('re-advertises when dns-sd is killed by an external process', async () => {
      await startServer({})
      expect(dnssdSpawns()).toHaveLength(1)

      // An outside SIGTERM (the exact failure that broke discovery).
      latestChild().emit('exit', null, 'SIGTERM')

      // Nothing immediate: the ladder's first step is 1s.
      expect(dnssdSpawns()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(dnssdSpawns()).toHaveLength(2)
    })

    it('escalates the delay across consecutive failures', async () => {
      await startServer({})

      latestChild().emit('exit', null, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(dnssdSpawns()).toHaveLength(2)

      // Second failure waits 5s, not 1s.
      latestChild().emit('exit', null, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(dnssdSpawns()).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(dnssdSpawns()).toHaveLength(3)
    })

    it('resets the ladder once mDNSResponder confirms registration', async () => {
      await startServer({})

      latestChild().emit('exit', null, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(dnssdSpawns()).toHaveLength(2)

      // A healthy registration clears the accumulated failure count, so the
      // next unexpected death waits 1s again rather than 5s.
      latestChild().stdout.emit('data', Buffer.from(
        'Got a reply for service host._ion._tcp.local.: Name now registered and active',
      ))

      latestChild().emit('exit', null, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(dnssdSpawns()).toHaveLength(3)
    })

    it('does not respawn after an intentional stop', async () => {
      const server = await startServer({})
      expect(dnssdSpawns()).toHaveLength(1)

      // stop() -> _unadvertiseBonjour() kills the child, which emits 'exit'.
      await server.stop()

      await vi.advanceTimersByTimeAsync(60_000)
      expect(dnssdSpawns()).toHaveLength(1)
    })

    it('cancels a pending respawn when the server is stopped mid-backoff', async () => {
      const server = await startServer({})
      latestChild().emit('exit', null, 'SIGTERM')

      // Stop while the 1s respawn timer is still pending.
      await server.stop()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(dnssdSpawns()).toHaveLength(1)
    })
  })

  // A child that never starts signals on a DIFFERENT path than a child that
  // dies: a failed spawn emits 'error' (and usually no 'exit' at all), while a
  // killed child emits only 'exit'. Verified by probe:
  //   ENOENT  -> error
  //   EACCES  -> error
  //   killed  -> exit(null,SIGTERM)
  // The first ladder was wired to 'exit' only, so ENOENT/EACCES/EMFILE/EAGAIN
  // left the desktop invisible on mDNS until the whole app restarted — the same
  // "iOS cannot discover the desktop" defect the ladder was built to prevent.
  describe('respawn after a failed spawn', () => {
    it('re-advertises when dns-sd fails to spawn (error event)', async () => {
      await startServer({})
      expect(dnssdSpawns()).toHaveLength(1)

      // ENOENT / EACCES / EMFILE all arrive here, never on 'exit'.
      latestChild().emit('error', new Error('spawn /usr/bin/dns-sd ENOENT'))

      // Same ladder as a death: nothing immediate, then the 1s step.
      expect(dnssdSpawns()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(dnssdSpawns()).toHaveLength(2)
    })

    it('re-advertises when spawn throws synchronously', async () => {
      // First spawn throws; later spawns succeed, so a recovery is observable.
      let first = true
      spawnMock.mockImplementation(() => {
        if (first) {
          first = false
          throw new Error('EAGAIN')
        }
        const child = new FakeDnssd()
        children.push(child)
        return child
      })

      await startServer({})
      // The throw is caught, so no child exists yet.
      expect(children).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(dnssdSpawns()).toHaveLength(2)
      expect(children).toHaveLength(1)
    })

    it('schedules exactly one respawn when a spawn emits both error and exit', async () => {
      await startServer({})
      const child = latestChild()

      // Node documents that 'exit' may or may not follow 'error'. Both paths
      // schedule recovery, so the guard must collapse them into one attempt —
      // otherwise the ladder double-advances (1s -> 30s after two failures).
      child.emit('error', new Error('spawn EACCES'))
      child.emit('exit', null, null)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(dnssdSpawns()).toHaveLength(2)

      // Ladder advanced ONE step, so the next failure waits 5s, not 30s.
      latestChild().emit('error', new Error('spawn EACCES'))
      await vi.advanceTimersByTimeAsync(4_999)
      expect(dnssdSpawns()).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(dnssdSpawns()).toHaveLength(3)
    })

    it('does not respawn after a spawn error once the server is stopped', async () => {
      const server = await startServer({})
      latestChild().emit('error', new Error('spawn ENOENT'))

      // Stop while the spawn-error respawn timer is pending.
      await server.stop()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(dnssdSpawns()).toHaveLength(1)
    })
  })
})
