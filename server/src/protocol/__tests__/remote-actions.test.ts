/**
 * Pins the `remote.*` surface: what a Studio client may do to this
 * Environment's remote-display name and its relay settings, and with which scope.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const deps = vi.hoisted(() => ({
  // A minimal emitter rather than node's: `vi.hoisted` runs before imports,
  // so nothing imported is in scope here. `on`/`emit` is all the code under
  // test uses.
  relayDiscovery: (() => {
    const listeners: Array<(relays: unknown) => void> = []
    return {
      startBrowsing: vi.fn(),
      stopBrowsing: vi.fn(),
      relays: [{ host: 'r' }],
      on: (_event: string, fn: (relays: unknown) => void) => { listeners.push(fn) },
      emit: (_event: string, relays: unknown) => { for (const fn of [...listeners]) fn(relays) },
      removeAllListeners: () => { listeners.length = 0 },
    }
  })(),
  broadcast: vi.fn(),
  setRemoteDisplay: vi.fn(() => ({ applied: true, value: { customName: 'Mac', customIcon: null, updatedAt: 1 } })),
  readRemoteDisplay: vi.fn(() => ({ customName: 'Mac', customIcon: null, updatedAt: 1 })),
  probeRelayAuthConfig: vi.fn(async () => ({ oidc: false })),
}))
vi.mock('../../state', () => ({ state: {}, relayDiscovery: deps.relayDiscovery, enterprisePolicyCache: { policy: null } }))
vi.mock('../../broadcast', () => ({ broadcast: deps.broadcast }))
vi.mock('../../remote/handlers/display', () => ({ setRemoteDisplay: deps.setRemoteDisplay, readRemoteDisplay: deps.readRemoteDisplay }))
vi.mock('../../remote/relay-auth', () => ({ probeRelayAuthConfig: deps.probeRelayAuthConfig }))
vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { REMOTE_ACTIONS, _resetRelayDiscoveryBroadcastForTest } from '../remote-actions'
import { MISC_ACTIONS } from '../misc-actions'
import { handleAction } from '../actions'
import type { Connection } from '../connection'

const local = { id: 'c-local', transport: 'local', clientKind: 'desktop', scopes: ['admin'] } as unknown as Connection
const tcp = { id: 'c-tcp', transport: 'tcp', clientKind: 'web', scopes: ['admin'] } as unknown as Connection

beforeEach(() => {
  deps.broadcast.mockClear()
  deps.relayDiscovery.removeAllListeners()
  _resetRelayDiscoveryBroadcastForTest()
})

describe('REMOTE_ACTIONS', () => {
  it('is dispatched through MISC_ACTIONS; relay writes are admin, reads conversations:read, and the display name is an operator edit', () => {
    for (const [name, spec] of Object.entries(REMOTE_ACTIONS)) {
      expect(MISC_ACTIONS[name], name).toBe(spec)
      const expected = name === 'remote.getDisplay' ? 'conversations:read' : name === 'remote.setDisplay' ? 'conversations:operate' : 'admin'
      expect(spec.requiredScope, name).toBe(expected)
    }
  })

  it('runs every relay verb for an admin that is not the local desktop', async () => {
    deps.relayDiscovery.startBrowsing.mockClear()
    for (const name of ['remote.discoverRelays', 'remote.stopDiscovery', 'remote.relayAuthConfig']) {
      const outcome = await REMOTE_ACTIONS[name].handler(tcp, ['wss://relay.example.org'])
      expect(outcome.ok, name).toBe(true)
    }
    expect(deps.relayDiscovery.startBrowsing).toHaveBeenCalledTimes(1)
    expect(deps.relayDiscovery.stopBrowsing).toHaveBeenCalled()
    expect(deps.probeRelayAuthConfig).toHaveBeenCalledWith('wss://relay.example.org')
    expect(Object.values(REMOTE_ACTIONS).some((spec) => spec.localOnly)).toBe(false)
  })

  it('refuses a relay verb to a connection without admin at the dispatcher, before it runs', async () => {
    deps.relayDiscovery.startBrowsing.mockClear()
    const sent: unknown[] = []
    const member = { id: 'c-member', transport: 'tcp', clientKind: 'ios', scopes: ['conversations:operate'], principal: { subject: 'member' }, send: (frame: unknown) => sent.push(frame) } as unknown as Connection
    for (const name of ['remote.testRelay', 'remote.discoverRelays', 'remote.stopDiscovery', 'remote.relayAuthConfig']) {
      await handleAction(member, { type: 'studio_action', id: name, action: name, args: ['wss://relay.example.org', 'k'] })
    }
    expect(sent).toEqual(['remote.testRelay', 'remote.discoverRelays', 'remote.stopDiscovery', 'remote.relayAuthConfig'].map((name) => ({
      type: 'studio_action_result', id: name, ok: false, refusal: { code: 'scope', message: `${name} requires scope admin` },
    })))
    expect(deps.relayDiscovery.startBrowsing).not.toHaveBeenCalled()
  })

  it('setDisplay persists and broadcasts the applied value to every client', async () => {
    const outcome = await REMOTE_ACTIONS['remote.setDisplay'].handler(local, ['Mac', null])
    expect(outcome).toEqual({ ok: true, value: { customName: 'Mac', customIcon: null, updatedAt: 1 } })
    expect(deps.broadcast).toHaveBeenCalledWith('ion:remote-display-changed', { customName: 'Mac', customIcon: null, updatedAt: 1 })
  })

  it('setDisplay is open to a client that is not the local desktop, and carries its own timestamp', async () => {
    deps.setRemoteDisplay.mockClear()
    const outcome = await REMOTE_ACTIONS['remote.setDisplay'].handler(tcp, ['Studio Mac', 'laptop', 1700000000000])
    expect(outcome).toEqual({ ok: true, value: { customName: 'Mac', customIcon: null, updatedAt: 1 } })
    expect(deps.setRemoteDisplay).toHaveBeenCalledWith('Studio Mac', 'laptop', 1700000000000, 'desktop')
  })

  it('setDisplay answers the stored value, without broadcasting, when a newer edit already won', async () => {
    deps.setRemoteDisplay.mockReturnValueOnce({ applied: false, value: { customName: 'Newer', customIcon: null, updatedAt: 99 } })
    expect(await REMOTE_ACTIONS['remote.setDisplay'].handler(tcp, ['Older', null, 5])).toEqual({ ok: true, value: { customName: 'Newer', customIcon: null, updatedAt: 99 } })
    expect(deps.broadcast).not.toHaveBeenCalled()
  })

  it('setDisplay stamps an edit that carries no timestamp, and refuses one that is not a positive number', async () => {
    deps.setRemoteDisplay.mockClear()
    const before = Date.now()
    await REMOTE_ACTIONS['remote.setDisplay'].handler(local, ['Mac', null])
    const stamped = (deps.setRemoteDisplay.mock.calls[0] as unknown as [string, null, number, string])[2]
    expect(stamped).toBeGreaterThanOrEqual(before)
    deps.setRemoteDisplay.mockClear()
    expect(await REMOTE_ACTIONS['remote.setDisplay'].handler(local, ['Mac', null, -4])).toMatchObject({ ok: false, error: { code: 'action_failed' } })
    expect(deps.setRemoteDisplay).not.toHaveBeenCalled()
  })

  it('discoverRelays starts browsing and returns what is known so far', async () => {
    deps.relayDiscovery.startBrowsing.mockClear()
    expect(await REMOTE_ACTIONS['remote.discoverRelays'].handler(local, [])).toEqual({ ok: true, value: [{ host: 'r' }] })
    expect(deps.relayDiscovery.startBrowsing).toHaveBeenCalledTimes(1)
  })
})

describe('relay discovery fan-out', () => {
  // Regression: `wireRemoteControlEvents` in the deleted transport controller
  // was the only producer of REMOTE_RELAYS_CHANGED. Without a replacement the
  // action answers with what is already known and every relay found after it
  // returns is never seen, while the settings panel sits subscribed to a
  // channel nobody writes to.
  it('publishes relays found after the action returned', async () => {
    await REMOTE_ACTIONS['remote.discoverRelays'].handler(local, [])

    const found = [{ id: 'r1', name: 'Relay', host: 'h', port: 8443, addresses: [] }]
    deps.relayDiscovery.emit('relays-changed', found)

    expect(deps.broadcast).toHaveBeenCalledWith('ion:remote-relays-changed', found)
  })

  it('does not stack a second listener when discovery is restarted', async () => {
    await REMOTE_ACTIONS['remote.discoverRelays'].handler(local, [])
    await REMOTE_ACTIONS['remote.stopDiscovery'].handler(local, [])
    await REMOTE_ACTIONS['remote.discoverRelays'].handler(local, [])

    deps.relayDiscovery.emit('relays-changed', [])

    expect(deps.broadcast.mock.calls.filter((c) => c[0] === 'ion:remote-relays-changed')).toHaveLength(1)
  })
})
