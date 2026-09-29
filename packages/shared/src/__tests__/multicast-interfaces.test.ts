import { describe, it, expect } from 'vitest'
import { multicastOptionsPerInterface } from '../multicast-interfaces'

import type { NetworkInterfaceInfo } from 'os'

const iface = (address: string, family: 'IPv4' | 'IPv6', internal = false): NetworkInterfaceInfo =>
  family === 'IPv4'
    ? { address, family, internal, netmask: '', mac: '', cidr: null }
    : { address, family, internal, netmask: '', mac: '', cidr: null, scopeid: 0 }

describe('multicastOptionsPerInterface', () => {
  it('pins one responder to every real IPv4 interface, bound to the wildcard', () => {
    const options = multicastOptionsPerInterface({
      'Ethernet': [iface('10.211.55.3', 'IPv4'), iface('fe80::1', 'IPv6')],
      'vEthernet (Default Switch)': [iface('172.17.32.1', 'IPv4')],
      'Loopback': [iface('127.0.0.1', 'IPv4', true)],
    })
    expect(options).toEqual([
      { interface: '10.211.55.3', bind: '0.0.0.0' },
      { interface: '172.17.32.1', bind: '0.0.0.0' },
    ])
  })

  it('is empty with no LAN interface, so the caller keeps the default responder', () => {
    expect(multicastOptionsPerInterface({ Loopback: [iface('127.0.0.1', 'IPv4', true)] })).toEqual([])
  })
})
