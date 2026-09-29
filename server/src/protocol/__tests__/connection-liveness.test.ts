/**
 * Connection liveness — the heartbeat that keeps `ConnectionRegistry` honest.
 *
 * A socket dropped by an intermediary (a CDN or reverse-proxy idle timeout) or
 * by a sleeping client never delivers a close event, so without a heartbeat the
 * registry keeps believing in a connection nobody is reading. Events are then
 * written into it and lost, and `hello.ts` refuses the real client its own
 * clientId on every reconnect — which is how two browsers ended up each holding
 * half of one conversation.
 *
 * Driven through `sweepConnectionLiveness()` directly rather than a timer: a
 * real `ws` client answers pings automatically at the protocol level, so it
 * cannot express "the peer stopped answering" — the state this exists for.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import type WebSocket from 'ws'
import { Connection, connectionRegistry } from '../connection'
import { sweepConnectionLiveness } from '../listener'

function fakeSocket() {
  return { ping: vi.fn(), terminate: vi.fn(), send: vi.fn(), close: vi.fn() }
}

function registerConnection(): { conn: Connection; ws: ReturnType<typeof fakeSocket> } {
  const ws = fakeSocket()
  const conn = new Connection(ws as unknown as WebSocket, 'tcp')
  conn.clientId = 'client-under-test'
  connectionRegistry.add(conn)
  return { conn, ws }
}

afterEach(() => {
  for (const c of connectionRegistry.all()) connectionRegistry.remove(c)
})

describe('sweepConnectionLiveness', () => {
  it('pings a live connection and leaves it registered', () => {
    const { conn, ws } = registerConnection()
    sweepConnectionLiveness()
    expect(ws.ping).toHaveBeenCalledTimes(1)
    expect(ws.terminate).not.toHaveBeenCalled()
    expect(connectionRegistry.all()).toContain(conn)
  })

  it('keeps a connection that answers the ping', () => {
    const { conn, ws } = registerConnection()
    sweepConnectionLiveness()
    conn.markPongReceived()
    sweepConnectionLiveness()
    expect(ws.ping).toHaveBeenCalledTimes(2)
    expect(ws.terminate).not.toHaveBeenCalled()
    expect(connectionRegistry.all()).toContain(conn)
  })

  it('terminates and unregisters a connection that never answers', () => {
    const { conn, ws } = registerConnection()
    sweepConnectionLiveness() // ping goes out
    sweepConnectionLiveness() // still no pong -> the peer is gone
    expect(ws.terminate).toHaveBeenCalledTimes(1)
    expect(connectionRegistry.all()).not.toContain(conn)
  })

  it('frees the clientId so the real client can reconnect under it', () => {
    const { ws } = registerConnection()
    sweepConnectionLiveness()
    sweepConnectionLiveness()
    expect(ws.terminate).toHaveBeenCalled()
    // This is the whole point: findByClientId is what hello.ts consults, and
    // a stale entry here is what locked the client out of its own identity.
    expect(connectionRegistry.findByClientId('client-under-test')).toBeUndefined()
  })

  it('reaps an already-closed connection without pinging it', () => {
    const { conn, ws } = registerConnection()
    conn.markClosed()
    sweepConnectionLiveness()
    expect(ws.ping).not.toHaveBeenCalled()
    expect(connectionRegistry.all()).not.toContain(conn)
  })
})
