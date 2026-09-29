/**
 * A Unix domain socket file outlives the process that created it when that
 * process is killed rather than shut down (SIGKILL, OOM, a force-deleted
 * container). `startHealth` must clear such a stale entry and bind anyway —
 * without that, `listen()` fails EADDRINUSE, the error is only logged, and
 * the server runs on having silently lost its local wire.
 *
 * The companion case matters just as much: when a LIVE process owns the
 * socket, the file must NOT be removed, because stealing it from a running
 * peer is exactly what EADDRINUSE exists to prevent.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'net'
import { existsSync, writeFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startHealth, type HealthHandle } from '../health'

const started: HealthHandle[] = []
const rawServers: Server[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(started.splice(0).map((h) => h.close()))
  await Promise.all(
    rawServers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  )
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ion-health-sock-'))
  dirs.push(d)
  return d
}

/** Resolves once the handle's local server is listening, or rejects on timeout. */
function listening(handle: HealthHandle): Promise<void> {
  const server = handle.localServer
  if (!server) throw new Error('no local server')
  if (server.listening) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('did not start listening')), 3000)
    server.once('listening', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

describe('startHealth local socket', () => {
  it('clears a stale socket file and binds anyway', async () => {
    const socketPath = join(scratch(), 'studio.sock')
    // A plain file stands in for the entry a killed process leaves behind:
    // it exists, and connecting to it is refused.
    writeFileSync(socketPath, '')
    expect(existsSync(socketPath)).toBe(true)

    const handle = startHealth({ socketPath })
    started.push(handle)
    await listening(handle)

    expect(handle.localServer?.listening).toBe(true)
  })

  it('leaves a socket owned by a live process alone', async () => {
    const socketPath = join(scratch(), 'studio.sock')
    const live = createServer()
    rawServers.push(live)
    await new Promise<void>((resolve) => live.listen(socketPath, () => resolve()))

    const owned: string[] = []
    const handle = startHealth({ socketPath, onLocalSocketOwned: (p) => owned.push(p) })
    started.push(handle)
    // The bind must fail rather than evict the live owner, so the second
    // server never reaches 'listening' and the live one keeps the socket.
    await expect(listening(handle)).rejects.toThrow('did not start listening')
    expect(live.listening).toBe(true)
    // And the caller is told, so main.ts can refuse to run as a second
    // instance instead of carrying on half-bound.
    expect(owned).toEqual([socketPath])
  })

  it('does not report a live owner for a stale or absent socket', async () => {
    const dir = scratch()
    const stale = join(dir, 'stale.sock')
    writeFileSync(stale, '')
    const owned: string[] = []
    const a = startHealth({ socketPath: stale, onLocalSocketOwned: (p) => owned.push(p) })
    started.push(a)
    await listening(a)
    const b = startHealth({ socketPath: join(dir, 'fresh.sock'), onLocalSocketOwned: (p) => owned.push(p) })
    started.push(b)
    await listening(b)
    expect(owned).toEqual([])
  })
})
