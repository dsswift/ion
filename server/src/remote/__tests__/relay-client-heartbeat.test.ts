/**
 * A relay socket stranded by a network change looks open from this side and
 * never closes: the relay dropped it, and an idle channel sends nothing that
 * would fail. The client's own ping is what finds it. These run against a
 * real WebSocket server, because the failure lives in the socket, not in the
 * client's bookkeeping.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import type { AddressInfo } from 'net'
import { RelayClient } from '../relay-client'

vi.mock('../../logger', () => ({ log: vi.fn(), error: vi.fn() }))

const servers: WebSocketServer[] = []
const clients: RelayClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    for (const socket of server.clients) socket.terminate()
    server.close(() => resolve())
  })))
})

/** A relay stand-in; `autoPong: false` is a peer that no longer answers. */
async function relay(autoPong: boolean): Promise<{ url: string; joins: () => number }> {
  const server = new WebSocketServer({ port: 0, autoPong })
  servers.push(server)
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  let count = 0
  server.on('connection', () => { count++ })
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, joins: () => count }
}

function client(url: string): RelayClient {
  const c = new RelayClient({ relayUrl: url, apiKey: 'k', channelId: 'channel-1', heartbeatIntervalMs: 50 })
  clients.push(c)
  return c
}

describe('relay client heartbeat', () => {
  it('drops a socket the relay stopped answering and joins again', async () => {
    const { url, joins } = await relay(false)
    const c = client(url)
    const disconnected = new Promise<void>((resolve) => c.once('disconnected', () => resolve()))
    c.connect()

    await disconnected
    await vi.waitFor(() => expect(joins()).toBeGreaterThanOrEqual(2), { timeout: 5_000 })
  })

  it('keeps a socket the relay keeps answering', async () => {
    const { url, joins } = await relay(true)
    const c = client(url)
    const onDisconnected = vi.fn()
    c.on('disconnected', onDisconnected)
    const connected = new Promise<void>((resolve) => c.once('connected', () => resolve()))
    c.connect()
    await connected

    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(onDisconnected).not.toHaveBeenCalled()
    expect(c.connected).toBe(true)
    expect(joins()).toBe(1)
  })
})
