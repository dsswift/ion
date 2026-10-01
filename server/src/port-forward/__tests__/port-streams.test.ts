/**
 * The server end of a Port Forward against a real loopback listener: the
 * stream dials it, carries bytes both ways, and ends with its connection.
 */
import { afterEach, describe, expect, it } from 'vitest'
import net from 'net'
import { BinaryChannel } from '@ion/shared/studio-wire/channels'
import { PORT_END_ABORT } from '@ion/shared/port-forward'
import { MAX_PORT_STREAMS_PER_CONNECTION, closePortStreamsForConnection, handlePortFrame, openPortStream, portStreamCount, type PortStreamCarrier } from '../port-streams'

interface SentFrame { channel: BinaryChannel; key: string; payload: Uint8Array }

let nextCarrier = 1
function carrier(): PortStreamCarrier & { sent: SentFrame[] } {
  const sent: SentFrame[] = []
  return {
    id: `test-conn-${nextCarrier++}`,
    sent,
    sendBinaryPaced: async (channel, key, payload) => {
      sent.push({ channel, key, payload: Uint8Array.from(payload) })
      return true
    },
  }
}

const servers: net.Server[] = []
const carriers: string[] = []

/** A loopback listener that answers every chunk with the same bytes, upper-cased. */
async function echoServer(): Promise<number> {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => socket.write(chunk.toString('utf-8').toUpperCase()))
    socket.on('error', () => {})
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as net.AddressInfo).port
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function received(conn: { sent: SentFrame[] }, streamId: string): string {
  return Buffer.concat(conn.sent.filter((f) => f.channel === BinaryChannel.PORT_DATA && f.key === streamId).map((f) => f.payload)).toString('utf-8')
}

afterEach(async () => {
  for (const id of carriers.splice(0)) closePortStreamsForConnection(id, 'test ended')
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

describe('port streams', () => {
  it('carries bytes to the dialed port and back', async () => {
    const port = await echoServer()
    const conn = carrier()
    carriers.push(conn.id)

    expect(await openPortStream(conn, 's1', port)).toEqual({ ok: true })
    handlePortFrame(conn.id, BinaryChannel.PORT_DATA, 's1', Buffer.from('hello'))

    await until(() => received(conn, 's1') === 'HELLO')
    expect(portStreamCount(conn.id)).toBe(1)
  })

  it('closes the stream and reports its end when the client finishes', async () => {
    const port = await echoServer()
    const conn = carrier()
    carriers.push(conn.id)
    await openPortStream(conn, 's1', port)

    handlePortFrame(conn.id, BinaryChannel.PORT_END, 's1', new Uint8Array(0))

    await until(() => portStreamCount(conn.id) === 0)
    expect(conn.sent.some((f) => f.channel === BinaryChannel.PORT_END && f.payload.length === 0)).toBe(true)
  })

  it('drops the stream without an answer when the client abandons it', async () => {
    const port = await echoServer()
    const conn = carrier()
    carriers.push(conn.id)
    await openPortStream(conn, 's1', port)

    handlePortFrame(conn.id, BinaryChannel.PORT_END, 's1', new Uint8Array([PORT_END_ABORT]))

    expect(portStreamCount(conn.id)).toBe(0)
    expect(conn.sent.filter((f) => f.channel === BinaryChannel.PORT_END)).toEqual([])
  })

  it('refuses a port nothing listens on, and keeps no stream for it', async () => {
    const port = await echoServer()
    await new Promise((resolve) => servers.pop()!.close(resolve))
    const conn = carrier()
    carriers.push(conn.id)

    const outcome = await openPortStream(conn, 's1', port)

    expect(outcome).toMatchObject({ ok: false, code: 'connect_failed' })
    expect(portStreamCount(conn.id)).toBe(0)
  })

  it('refuses a malformed request and a reused stream id', async () => {
    const port = await echoServer()
    const conn = carrier()
    carriers.push(conn.id)

    expect(await openPortStream(conn, 's1', 70_000)).toMatchObject({ ok: false, code: 'bad_request' })
    expect(await openPortStream(conn, '', port)).toMatchObject({ ok: false, code: 'bad_request' })
    await openPortStream(conn, 's1', port)
    expect(await openPortStream(conn, 's1', port)).toMatchObject({ ok: false, code: 'stream_exists' })
  })

  it('bounds how many streams one connection holds', async () => {
    const port = await echoServer()
    const conn = carrier()
    carriers.push(conn.id)
    // One at a time: a burst of dials can outrun the listener's accept queue.
    for (let i = 0; i < MAX_PORT_STREAMS_PER_CONNECTION; i += 1) {
      expect(await openPortStream(conn, `s${i}`, port)).toEqual({ ok: true })
    }

    expect(await openPortStream(conn, 'one-too-many', port)).toMatchObject({ ok: false, code: 'too_many_streams' })
  })

  it('ends every stream of a connection that closed, and no other', async () => {
    const port = await echoServer()
    const gone = carrier()
    const kept = carrier()
    carriers.push(gone.id, kept.id)
    await openPortStream(gone, 's1', port)
    await openPortStream(gone, 's2', port)
    await openPortStream(kept, 's1', port)

    closePortStreamsForConnection(gone.id, 'connection closed')

    expect(portStreamCount(gone.id)).toBe(0)
    expect(portStreamCount(kept.id)).toBe(1)
    // The connection is gone, so nothing is sent on it.
    expect(gone.sent.filter((f) => f.channel === BinaryChannel.PORT_END)).toEqual([])
  })
})
