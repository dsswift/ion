/**
 * A paired connection over TCP is sealed.
 *
 * The server's listener is plain `ws://`, so the desktop names its pairing
 * at upgrade time (`?client=<id>`) and seals every frame with the pairing
 * secret. It seals only when the server said it can open envelopes: a server
 * that predates sealed TCP would close the socket over a frame it cannot
 * parse, so an old server still gets a plain connection (and a warning).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket as WsSocket } from 'ws'
import type { AddressInfo } from 'net'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { connectSealedTcp, serverSealsTcp } from '../transport-tcp'
import { sealRelayFrame, openRelayFrame } from '@ion/shared/studio-wire/relay-envelope'

const secret = Buffer.alloc(32, 5)

describe('connectSealedTcp', () => {
  let server: WebSocketServer
  let base: string
  const seen: { url: string; frames: string[] } = { url: '', frames: [] }

  beforeEach(async () => {
    server = new WebSocketServer({ port: 0 })
    await new Promise<void>((r) => server.once('listening', () => r()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    seen.frames = []
    server.on('connection', (ws: WsSocket, req) => {
      seen.url = req.url ?? ''
      ws.on('message', (raw) => {
        seen.frames.push(raw.toString())
        ws.send(sealRelayFrame('{"type":"studio_welcome"}', secret))
        ws.send(sealRelayFrame('{"type":"studio_welcome"}', Buffer.alloc(32, 6)))
      })
    })
  })
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())) })

  it('names the pairing at upgrade time, seals what it sends, and opens only what that pairing sealed', async () => {
    const socket = connectSealedTcp(base, 'client-9', secret)
    const received: string[] = []
    socket.on('message', (data) => received.push((data as Buffer).toString('utf-8')))
    await new Promise<void>((r) => socket.once('open', () => r()))
    socket.send('{"type":"studio_hello"}')
    await vi.waitFor(() => expect(received.length).toBe(1))

    expect(seen.url).toBe('/studio?client=client-9')
    // What crossed the wire is an envelope: the frame is not readable in it.
    expect(seen.frames[0]).not.toContain('studio_hello')
    expect(openRelayFrame(seen.frames[0], secret)?.bytes.toString('utf-8')).toBe('{"type":"studio_hello"}')
    // The second reply was sealed under another secret and never surfaces.
    expect(received).toEqual(['{"type":"studio_welcome"}'])
    socket.close()
  })
})

describe('serverSealsTcp', () => {
  it('is true only when the server said so', () => {
    expect(serverSealsTcp({ nonce: 'n', sealedTcp: true })).toBe(true)
    expect(serverSealsTcp({ nonce: 'n' })).toBe(false)
    expect(serverSealsTcp({ nonce: 'n', sealedTcp: 'yes' })).toBe(false)
  })
})
