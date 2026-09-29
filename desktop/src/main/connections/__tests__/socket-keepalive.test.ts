/**
 * A socket to a remote environment that a network change stranded looks
 * open and never closes on its own. The keepalive finds it and terminates
 * it, so the broker's close handling reconnects. Runs against a real
 * WebSocket server, since the failure lives in the socket.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import type { AddressInfo } from 'net'

vi.mock('../../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { keepSocketAlive } from '../socket-keepalive'

const servers: WebSocketServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    for (const socket of server.clients) socket.terminate()
    server.close(() => resolve())
  })))
})

/** `autoPong: false` stands in for a far end that no longer hears this socket. */
async function serverUrl(autoPong: boolean): Promise<string> {
  const server = new WebSocketServer({ port: 0, autoPong })
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('keepSocketAlive', () => {
  it('terminates a socket whose far end stopped answering', async () => {
    const ws = keepSocketAlive(new WebSocket(await serverUrl(false)), 'test-peer', 50)
    const code = await new Promise<number>((resolve) => ws.once('close', (c: number) => resolve(c)))
    expect(code).toBe(1006)
  })

  it('leaves a socket alone while its far end answers', async () => {
    const ws = keepSocketAlive(new WebSocket(await serverUrl(true)), 'test-peer', 50)
    await new Promise<void>((resolve) => ws.once('open', () => resolve()))
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
  })
})
