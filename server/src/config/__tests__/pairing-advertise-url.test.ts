import { describe, expect, it, vi } from 'vitest'

const ifaces = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('os', async (orig) => ({
  ...(await orig<typeof import('os')>()),
  hostname: () => 'jolteon',
  networkInterfaces: () => ifaces.value,
}))

import { pairingAdvertiseUrl } from '../server-config'

const config = (advertiseUrl: string | null = null) =>
  ({ pairing: { advertiseUrl, defaultScopes: [] }, listen: { tcp: { port: 7331 } } }) as never

/**
 * A pairing link is handed to a client that has never spoken to this server,
 * so the URL in it is the only way back. It used to be built from the bare
 * `os.hostname()` -- `http://jolteon:7331` -- which resolves nowhere: the
 * name carries no `.local` suffix, so no responder answers it.
 */
describe('pairingAdvertiseUrl', () => {
  const v4 = (address: string, internal: boolean) => ({ address, family: 'IPv4', internal })

  it('points at an address, never the bare host name', () => {
    ifaces.value = { lo0: [v4('127.0.0.1', true)], en0: [v4('192.168.1.237', false)] }
    const url = pairingAdvertiseUrl(config())
    expect(url).toBe('http://192.168.1.237:7331')
    expect(url).not.toBe('http://jolteon:7331')
  })

  // A host with nothing but loopback still has to produce something a client
  // could resolve. Its own `.local` name is answered by the OS.
  it('falls back to a resolvable name when there is no LAN address', () => {
    ifaces.value = { lo0: [v4('127.0.0.1', true)] }
    expect(pairingAdvertiseUrl(config())).toBe('http://jolteon.local:7331')
  })

  it('an explicit advertiseUrl still wins', () => {
    ifaces.value = { en0: [v4('192.168.1.237', false)] }
    expect(pairingAdvertiseUrl(config('https://ion.example.com'))).toBe('https://ion.example.com')
  })
})
