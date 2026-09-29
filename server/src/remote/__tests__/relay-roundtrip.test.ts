/**
 * End-to-end relay_announce round trip against a REAL relay binary (manifest
 * C7, specs/08-server-auth.md Acceptance Criteria: "Relay client test
 * (against the relay binary built from relay/): announce frame sent first; a
 * fixture bearer for the announced audience joins as mobile; a bearer for
 * another audience is refused.").
 *
 * Requires `ION_RELAY_BIN` to point at a relay binary built from `relay/`
 * (`cd relay && go build -o /tmp/ion-relay .`). The whole suite is skipped
 * (not failed) when that env var is unset, matching the spec's own
 * validation command (`ION_RELAY_BIN=/tmp/ion-relay npm -w server test --
 * run relay-roundtrip`) -- this file is not run as part of the default
 * `npm test` sweep for that reason.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'http'
import { spawn, type ChildProcess } from 'child_process'
import WebSocket from 'ws'
import { RelayClient } from '../relay-client'
import { startJwksFixture, signToken, type JwksFixture } from '../../auth/__tests__/jwks-fixture'

const RELAY_BIN = process.env.ION_RELAY_BIN

async function freeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = address && typeof address === 'object' ? address.port : 0
      srv.close((err) => (err ? reject(err) : resolve(port)))
    })
    srv.on('error', reject)
  })
}

async function waitForHealthz(port: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      if (res.ok) return
    } catch {
      // relay not accepting connections yet
    }
    if (Date.now() > deadline) throw new Error('relay /healthz never became ready')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Dials `role=mobile` on `channelId` with a bearer token. Resolves 'open' or 'refused' with the HTTP status when the relay rejected the upgrade. */
function dialMobile(port: number, channelId: string, token: string): Promise<{ outcome: 'open' } | { outcome: 'refused'; status?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/channel/${channelId}?role=mobile`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    ws.once('open', () => {
      resolve({ outcome: 'open' })
      ws.close()
    })
    ws.once('unexpected-response', (_req, res) => {
      resolve({ outcome: 'refused', status: res.statusCode })
      res.resume()
    })
    ws.once('error', () => {
      resolve({ outcome: 'refused' })
    })
  })
}

describe.skipIf(!RELAY_BIN)('relay_announce round trip against a real relay binary', () => {
  let fixture: JwksFixture
  let relayProcess: ChildProcess
  let relayPort: number
  let relayClient: RelayClient | undefined

  beforeEach(async () => {
    fixture = await startJwksFixture()
    relayPort = await freeTcpPort()
    relayProcess = spawn(RELAY_BIN as string, [], {
      env: {
        ...process.env,
        RELAY_PORT: String(relayPort),
        RELAY_API_KEY: 'test-relay-psk',
        RELAY_TRUSTED_ISSUERS: fixture.issuer,
      },
      stdio: 'pipe',
    })
    await waitForHealthz(relayPort)
  })

  afterEach(async () => {
    relayClient?.disconnect()
    relayClient = undefined
    relayProcess.kill()
    await fixture.close()
  })

  it('sends relay_announce first, then a matching-audience bearer joins and a mismatched-audience bearer is refused', async () => {
    const channelId = 'roundtrip-test-channel'
    const audience = 'api://studio-server-under-test'

    relayClient = new RelayClient({
      relayUrl: `ws://127.0.0.1:${relayPort}`,
      apiKey: 'test-relay-psk',
      channelId,
      announceTrust: { issuer: fixture.issuer, audience, scope: 'Studio.Access' },
    })

    const connected = new Promise<void>((resolve, reject) => {
      relayClient!.once('connected', () => resolve())
      relayClient!.once('failed', (failure) => reject(new Error(`relay client failed: ${JSON.stringify(failure)}`)))
    })
    relayClient.connect()
    await connected

    // Give the relay a moment to process the ion peer's first frame
    // (the announce) before a mobile peer tries to join the same channel --
    // the relay only inspects the FIRST frame from the ion role, so this
    // ordering is exactly what the manifest requires.
    await new Promise((resolve) => setTimeout(resolve, 100))

    const matchingToken = await signToken(fixture, { sub: 'mobile-user', aud: audience, scp: 'Studio.Access' })
    const matchingResult = await dialMobile(relayPort, channelId, matchingToken)
    expect(matchingResult.outcome).toBe('open')

    const mismatchedToken = await signToken(fixture, { sub: 'mobile-user', aud: 'api://some-other-audience', scp: 'Studio.Access' })
    const mismatchedResult = await dialMobile(relayPort, channelId, mismatchedToken)
    expect(mismatchedResult.outcome).toBe('refused')
  })
})
