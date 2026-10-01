/**
 * Port Forward, end to end inside one process: the desktop's manager on one
 * side, the server's stream module on the other, joined by a fake broker that
 * hands each side's frames to the other. The "remote" service is a real HTTP
 * server on loopback, so what is asserted is what a browser would get.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import http from 'http'
import net from 'net'
import { createHash, randomBytes } from 'crypto'
import type { BinaryChannel } from '@ion/shared/studio-wire/channels'
import { PORT_FORWARD_CAPABILITY } from '@ion/shared/port-forward'
import { closePortStreamsForConnection, handlePortFrame, openPortStream, portStreamCount } from '@ion/server/port-forward/port-streams'
import type { Broker } from '../broker'
import { PortForwardManager } from '../port-forward'

const ENV = 'env-remote'
const CONNECTION_ID = 'conn-under-test'

type BinaryListener = (environmentId: string, channel: BinaryChannel, key: string, payload: Uint8Array) => void
type PhaseListener = (environmentId: string, phase: { phase: string }) => void

/** A broker whose far end is the server's own port-stream module. */
function loopbackBroker() {
  const binaryListeners = new Set<BinaryListener>()
  const phaseListeners = new Set<PhaseListener>()
  let phase = 'connected'
  let capabilities: string[] | null = [PORT_FORWARD_CAPABILITY]
  const carrier = {
    id: CONNECTION_ID,
    sendBinaryPaced: async (channel: BinaryChannel, key: string, payload: Uint8Array): Promise<boolean> => {
      // A real connection delivers on a later turn of the event loop.
      await new Promise((resolve) => setImmediate(resolve))
      for (const cb of binaryListeners) cb(ENV, channel, key, Uint8Array.from(payload))
      return true
    },
  }
  const fake = {
    phaseOf: () => ({ phase }),
    serverCapabilities: () => capabilities,
    onBinary: (cb: BinaryListener) => { binaryListeners.add(cb); return () => binaryListeners.delete(cb) },
    onPhase: (cb: PhaseListener) => { phaseListeners.add(cb); return () => phaseListeners.delete(cb) },
    sendBinary: (_environmentId: string, channel: BinaryChannel, key: string, payload: Uint8Array): boolean => {
      const copy = Uint8Array.from(payload)
      setImmediate(() => handlePortFrame(CONNECTION_ID, channel, key, copy))
      return true
    },
    sendAction: async (_environmentId: string, action: string, args: unknown[]): Promise<unknown> => {
      if (action !== 'port.open') throw new Error(`unexpected action ${action}`)
      const request = args[0] as { streamId: string; port: number }
      const outcome = await openPortStream(carrier, request.streamId, request.port)
      if (!outcome.ok) throw new Error(outcome.message)
      return null
    },
  }
  return {
    broker: fake as unknown as Broker,
    setCapabilities: (next: string[] | null) => { capabilities = next },
    setPhase: (next: string) => {
      phase = next
      for (const cb of phaseListeners) cb(ENV, { phase: next })
    },
  }
}

const cleanups: Array<() => void | Promise<void>> = []

async function remoteHttpServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  return (server.address() as net.AddressInfo).port
}

function get(port: number, path = '/'): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function manager(broker: Broker): PortForwardManager {
  const m = new PortForwardManager(broker)
  cleanups.push(() => m.stopAll())
  return m
}

async function started(m: PortForwardManager, remotePort: number): Promise<number> {
  const result = await m.start(ENV, remotePort)
  if (!result.ok) throw new Error(result.error)
  return result.forward.localPort
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  closePortStreamsForConnection(CONNECTION_ID, 'test ended')
})

describe('PortForwardManager', () => {
  it('serves a remote HTTP service at a local port', async () => {
    const remotePort = await remoteHttpServer((req, res) => res.end(`hello from ${req.url}`))
    const { broker } = loopbackBroker()
    const localPort = await started(manager(broker), remotePort)

    // The remote port's own number is taken on this machine by the "remote" service itself.
    expect(localPort).not.toBe(remotePort)
    const response = await get(localPort, '/app?x=1')
    expect(response.status).toBe(200)
    expect(response.body.toString('utf-8')).toBe('hello from /app?x=1')
  })

  it('carries a body many times the stream window, intact', async () => {
    const payload = randomBytes(4 * 1024 * 1024)
    const remotePort = await remoteHttpServer((_req, res) => res.end(payload))
    const { broker } = loopbackBroker()
    const localPort = await started(manager(broker), remotePort)

    const response = await get(localPort)

    expect(response.body.length).toBe(payload.length)
    expect(createHash('sha256').update(response.body).digest('hex')).toBe(createHash('sha256').update(payload).digest('hex'))
  })

  it('carries an upload many times the stream window, intact', async () => {
    const payload = randomBytes(2 * 1024 * 1024)
    const remotePort = await remoteHttpServer((req, res) => {
      const hash = createHash('sha256')
      req.on('data', (chunk: Buffer) => hash.update(chunk))
      req.on('end', () => res.end(hash.digest('hex')))
    })
    const { broker } = loopbackBroker()
    const localPort = await started(manager(broker), remotePort)

    const digest = await new Promise<string>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: localPort, method: 'POST', agent: false }, (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => { body += chunk.toString('utf-8') })
        res.on('end', () => resolve(body))
      })
      req.on('error', reject)
      req.end(payload)
    })

    expect(digest).toBe(createHash('sha256').update(payload).digest('hex'))
  })

  it('serves concurrent connections on one forward without mixing them', async () => {
    const remotePort = await remoteHttpServer((req, res) => res.end(`answer ${req.url}`))
    const { broker } = loopbackBroker()
    const localPort = await started(manager(broker), remotePort)

    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => get(localPort, `/${i}`)))

    expect(responses.map((r) => r.body.toString('utf-8'))).toEqual(Array.from({ length: 12 }, (_, i) => `answer /${i}`))
  })

  it('returns the same forward when asked twice, and lists it', async () => {
    const remotePort = await remoteHttpServer((_req, res) => res.end('ok'))
    const { broker } = loopbackBroker()
    const m = manager(broker)

    const [first, second] = await Promise.all([m.start(ENV, remotePort), m.start(ENV, remotePort)])

    expect(first).toEqual(second)
    expect(m.list()).toEqual([{ environmentId: ENV, remotePort, localPort: first.ok ? first.forward.localPort : -1, activeStreams: 0 }])
  })

  it('stops listening when the forward is stopped', async () => {
    const remotePort = await remoteHttpServer((_req, res) => res.end('ok'))
    const { broker } = loopbackBroker()
    const m = manager(broker)
    const localPort = await started(m, remotePort)

    expect(m.stop(ENV, remotePort)).toBe(true)

    await expect(get(localPort)).rejects.toThrow()
    expect(m.list()).toEqual([])
    expect(m.stop(ENV, remotePort)).toBe(false)
  })

  it('refuses a local connection while the Environment is not connected, and serves again once it is', async () => {
    const remotePort = await remoteHttpServer((_req, res) => res.end('ok'))
    const { broker, setPhase } = loopbackBroker()
    const localPort = await started(manager(broker), remotePort)

    setPhase('backoff')
    await expect(get(localPort)).rejects.toThrow()

    setPhase('connected')
    expect((await get(localPort)).body.toString('utf-8')).toBe('ok')
  })

  it('ends a stream in flight when its Environment disconnects', async () => {
    // A service that never answers keeps the stream open until something ends it.
    const remotePort = await remoteHttpServer(() => {})
    const { broker, setPhase } = loopbackBroker()
    const m = manager(broker)
    const localPort = await started(m, remotePort)
    const pending = get(localPort)
    pending.catch(() => {}) // silent-ok: the rejection is asserted below; this only keeps it from being reported unhandled in between
    await vi.waitFor(() => expect(m.list()[0].activeStreams).toBe(1))

    setPhase('offline')

    await expect(pending).rejects.toThrow()
    expect(m.list()[0].activeStreams).toBe(0)
  })

  it('tells the server to drop a stream whose local client hung up', async () => {
    const remotePort = await remoteHttpServer(() => {})
    const { broker } = loopbackBroker()
    const m = manager(broker)
    const localPort = await started(m, remotePort)
    const socket = net.connect(localPort, '127.0.0.1')
    socket.on('error', () => {})
    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n')
    await vi.waitFor(() => expect(portStreamCount(CONNECTION_ID)).toBe(1))

    socket.destroy()

    await vi.waitFor(() => expect(portStreamCount(CONNECTION_ID)).toBe(0))
  })

  it('reports a refused request instead of throwing', async () => {
    const { broker } = loopbackBroker()
    expect(await manager(broker).start(ENV, 0)).toEqual({ ok: false, error: expect.stringContaining('1 and 65535') })
  })

  it('refuses to forward to a server that does not advertise port forwarding, and opens no local port', async () => {
    const { broker, setCapabilities } = loopbackBroker()
    setCapabilities(['graph', 'browser', 'terminal'])
    const m = manager(broker)

    expect(await m.start(ENV, 5173)).toEqual({ ok: false, error: expect.stringContaining('too old') })
    expect(m.list()).toEqual([])
  })

  it('refuses to forward to an Environment that is not connected', async () => {
    const { broker, setCapabilities } = loopbackBroker()
    setCapabilities(null)

    expect(await manager(broker).start(ENV, 5173)).toEqual({ ok: false, error: expect.stringContaining('not connected') })
  })

  it('notifies listeners with the settled list', async () => {
    const remotePort = await remoteHttpServer((_req, res) => res.end('ok'))
    const { broker } = loopbackBroker()
    const m = manager(broker)
    const seen: number[] = []
    m.onChange((forwards) => seen.push(forwards.length))

    await started(m, remotePort)

    await vi.waitFor(() => expect(seen).toEqual([1]))
  })
})
