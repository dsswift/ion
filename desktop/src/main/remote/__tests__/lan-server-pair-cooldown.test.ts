// Regression test for the pair-then-blocked loop: a successful pairing must
// clear the auth-failure cooldown for the pairing peer's IP. Without that, a
// device that failed auth under its old (revoked) identity re-pairs on /pair
// (exempt from the cooldown gate) but its very next /ws auth connection is
// closed 1008 by the cooldown — an immediate, inexplicable auth failure right
// after entering the PIN. Fails on the unfixed code at the final assertion
// (the post-pair /ws connect is rejected instead of accepted).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WebSocket } from 'ws'
import { LANServer } from '../lan-server'

vi.mock('../../logger', () => ({
  log: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
}))

const TEST_PORT = 47831

function connect(path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}${path}`)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

/** Resolve with the close code of a socket (opens then observes close). */
function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on('close', (code) => resolve(code)))
}

describe('LANServer pairing clears auth cooldown', () => {
  let server: LANServer

  beforeEach(async () => {
    server = new LANServer({ port: TEST_PORT })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
  })

  it('accepts a /ws connection after successful pairing despite prior auth failures', async () => {
    // Learn the IP string the server sees for loopback connections.
    const ipPromise = new Promise<string>((resolve) => {
      server.once('raw-client-connected', (_ws: unknown, connectionId: string) => {
        resolve(server.getClientIp(connectionId) ?? '')
      })
    })
    const probe = await connect('/')
    const ip = await ipPromise
    probe.close()
    expect(ip).not.toBe('')

    // Simulate repeated auth failures (revoked-device reconnect loop) so the
    // IP enters cooldown. Three failures → 30s block, far longer than the test.
    server.recordAuthFailure(ip)
    server.recordAuthFailure(ip)
    server.recordAuthFailure(ip)

    // Cooldown gate active: a /ws connection is closed 1008 without handshake.
    const blocked = await connect('/')
    expect(await closeCode(blocked)).toBe(1008)

    // Pair on /pair (exempt from the gate) and answer with a success response.
    server.once('pair-request', (req: { respond: (r: Record<string, unknown>) => void }) => {
      req.respond({ type: 'pair_response', publicKey: 'test-public-key' })
    })
    const pairWs = await connect('/pair')
    pairWs.send(JSON.stringify({ type: 'pair_request', code: '123456', publicKey: 'peer-key', deviceName: 'test' }))
    // Server closes the pairing socket ~500ms after responding.
    await closeCode(pairWs)

    // The just-paired peer's next /ws connection must be accepted (auth
    // handshake starts), not 1008-closed by the stale cooldown.
    const accepted = new Promise<boolean>((resolve) => {
      server.once('raw-client-connected', () => resolve(true))
    })
    const postPair = await connect('/')
    const race = await Promise.race([
      accepted,
      closeCode(postPair).then((code) => code === 1008 ? false : true),
    ])
    expect(race).toBe(true)
    postPair.close()
  })
})
