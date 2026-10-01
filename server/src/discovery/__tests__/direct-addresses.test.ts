import { describe, expect, it } from 'vitest'
import { directAddresses, lanHostname, reachableAddresses } from '../direct-addresses'

/**
 * A paired client probes one stored address before falling back to a relay.
 * That address used to come only from a Bonjour browse, so a client paired
 * over a relay never had one. These are what the welcome offers instead.
 */
describe('directAddresses', () => {
  const v4 = (address: string, internal: boolean) => ({ address, family: 'IPv4', internal }) as never

  it('offers every non-loopback IPv4 address with the listen port', () => {
    const urls = directAddresses(7331, {
      lo0: [v4('127.0.0.1', true)],
      en0: [v4('192.168.1.237', false)],
      en1: [v4('10.0.0.4', false)],
    })
    expect(urls).toEqual(['http://192.168.1.237:7331', 'http://10.0.0.4:7331'])
  })

  // Node reports `family` as 'IPv4' on current releases and 4 on older ones.
  // Pinning one silently returns nothing on the other, which reads to a client
  // exactly like a server with no LAN address at all.
  it('accepts either spelling of the IPv4 family', () => {
    const legacy = [{ address: '192.168.1.5', family: 4, internal: false }] as never
    expect(directAddresses(7331, { en0: legacy })).toEqual(['http://192.168.1.5:7331'])
  })

  it('offers nothing when the host has only loopback', () => {
    expect(directAddresses(7331, { lo0: [v4('127.0.0.1', true)] })).toEqual([])
  })
})

/**
 * A laptop carried to another network keeps none of its addresses. Its
 * `.local` name is the one thing a client can still reach it by, so the
 * welcome offers it after the addresses.
 */
describe('reachableAddresses', () => {
  const v4 = (address: string) => ({ address, family: 'IPv4', internal: false }) as never

  it('offers the addresses first and the .local name last', () => {
    expect(reachableAddresses(7331, { en0: [v4('192.168.1.211')] }, 'macbook.local'))
      .toEqual(['http://192.168.1.211:7331', 'http://macbook.local:7331'])
  })

  it('still offers the name when the host has no LAN address', () => {
    expect(reachableAddresses(7331, {}, 'macbook.local')).toEqual(['http://macbook.local:7331'])
  })

  it('offers no name when there is none', () => {
    expect(reachableAddresses(7331, { en0: [v4('10.0.0.4')] }, '')).toEqual(['http://10.0.0.4:7331'])
  })
})

describe('lanHostname', () => {
  // A DHCP server can rename a Mac's host name; the Bonjour name stays.
  it('uses the LocalHostName on macOS, not the host name', () => {
    expect(lanHostname({ platform: 'darwin', localHostName: () => 'macbook', hostname: () => 'lease-42.corp.example.com' })).toBe('macbook.local')
  })

  it('falls back to the host name when the LocalHostName cannot be read', () => {
    expect(lanHostname({ platform: 'darwin', localHostName: () => { throw new Error('scutil missing') }, hostname: () => 'jolteon' })).toBe('jolteon.local')
  })

  it('uses the first label of the host name elsewhere', () => {
    expect(lanHostname({ platform: 'linux', hostname: () => 'devbox.example.org' })).toBe('devbox.local')
    expect(lanHostname({ platform: 'linux', hostname: () => 'devbox.local' })).toBe('devbox.local')
  })

  it('returns nothing for an empty host name', () => {
    expect(lanHostname({ platform: 'linux', hostname: () => '' })).toBe('')
  })
})
