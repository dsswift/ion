import { beforeEach, describe, expect, it, vi } from 'vitest'

const published = vi.hoisted(() => [] as Array<{ txt: Record<string, string>; host?: string }>)
const constructed = vi.hoisted(() => [] as Array<unknown>)
vi.mock('bonjour-service', () => ({
  Bonjour: class {
    constructor(opts?: unknown) { constructed.push(opts) }
    publish(options: { txt: Record<string, string>; host?: string }) {
      published.push(options)
      return { on: vi.fn(), stop: vi.fn() }
    }
    destroy(): void {}
  },
}))

import { hostname } from 'os'
import { advertisedHostname, BonjourStudioAdvertiser } from '../advertiser'

describe('BonjourStudioAdvertiser TXT record', () => {
  const base = { label: 'box', environmentId: 'env-1', serverVersion: '0.1.0', port: 7331, mobilePort: 0 }
  beforeEach(() => { published.length = 0; constructed.length = 0 })

  // A phone paired on the desktop_* wire knows its server by machine id, not
  // by environment id, so this is what lets it pick the same server again.
  it('carries the host machine id as `machine`', () => {
    new BonjourStudioAdvertiser().start({ ...base, machineId: 'MACHINE-UUID-1' })
    expect(published[0].txt).toMatchObject({ id: 'env-1', machine: 'MACHINE-UUID-1' })
  })

  it('leaves `machine` off when the platform reported no machine id', () => {
    new BonjourStudioAdvertiser().start({ ...base, machineId: '' })
    expect(published[0].txt).not.toHaveProperty('machine')
  })

  // Regression, one half: this publisher emits an A record NAMED after
  // `host`, so passing the machine's own `.local` name claims a name the OS
  // already defends. macOS yielded and renamed itself `<name>-2.local`,
  // reporting to the operator that their computer's name was already in use
  // on the network -- by Ion, on their own machine.
  it('never claims the machine\'s own name', () => {
    new BonjourStudioAdvertiser().start({ ...base, machineId: 'MACHINE-UUID-1' })
    const host = published[0].host ?? ''
    expect(host).not.toBe(hostname())
    expect(host).not.toBe(`${hostname()}.local`)
  })

  // Regression, other half: leaving `host` unset targets the bare
  // `os.hostname()`, which carries no `.local` suffix and so resolves
  // nowhere. The desktop hid that by dialing the announced IP; iOS resolves
  // the endpoint through the OS, got nothing, and fell back to its relay.
  it('publishes a resolvable .local target', () => {
    new BonjourStudioAdvertiser().start({ ...base, machineId: 'MACHINE-UUID-1' })
    expect(published[0].host).toMatch(/\.local$/)
  })
})

describe('BonjourStudioAdvertiser interfaces', () => {
  const base = { label: 'box', environmentId: 'env-1', serverVersion: '0.1.0', port: 7331, machineId: '' }
  beforeEach(() => { published.length = 0; constructed.length = 0 })

  // Windows answered on a virtual switch instead of the LAN when the
  // library chose the multicast interface; one pinned responder per real
  // interface is what makes a peer on any of them hear the answer.
  it('publishes once per real interface, each responder pinned to its address', () => {
    const advertiser = new BonjourStudioAdvertiser(() => [
      { interface: '10.211.55.3', bind: '0.0.0.0' },
      { interface: '172.17.32.1', bind: '0.0.0.0' },
    ])
    advertiser.start(base)
    expect(constructed).toEqual([{ interface: '10.211.55.3', bind: '0.0.0.0' }, { interface: '172.17.32.1', bind: '0.0.0.0' }])
    expect(published).toHaveLength(2)
    expect(advertiser.advertising).toBe(true)
    advertiser.stop()
    expect(advertiser.advertising).toBe(false)
  })

  it('falls back to the default responder on a host with no LAN interface', () => {
    new BonjourStudioAdvertiser(() => []).start(base)
    expect(constructed).toEqual([undefined])
    expect(published).toHaveLength(1)
  })
})

describe('advertisedHostname', () => {
  it('derives a .local name of our own from the environment id', () => {
    expect(advertisedHostname('904e52bf-bb3b-4b0d-9f09-12dac01d4f6b')).toBe('ion-904e52bfbb3b4b0d.local')
  })

  // The same environment must answer to the same name after a restart, or a
  // client that cached the address is left dialing a name nobody holds.
  it('is stable for one environment', () => {
    expect(advertisedHostname('env-1')).toBe(advertisedHostname('env-1'))
    expect(advertisedHostname('env-1')).not.toBe(advertisedHostname('env-2'))
  })

  it('falls back to the host name, still as a name of our own', () => {
    expect(advertisedHostname('', 'macbook')).toBe('ion-macbook.local')
    expect(advertisedHostname('', '')).toBe('ion-studio.local')
  })
})
