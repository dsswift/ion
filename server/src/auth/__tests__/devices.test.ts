/**
 * Paired devices with their live connection: `auth.listClients` (admin, every
 * pairing) and `environment.devices` (the caller's own, no admin needed).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AUTH_ACTIONS } from '../actions'
import { credentialsStore, _resetCredentialsStoreForTest } from '../credentials-store'
import { connectedSince } from '../devices'
import { connectionRegistry, type Connection } from '../../protocol/connection'

let dir: string
const registered: Connection[] = []

function live(id: string, pairedClientId: string | null, connectedAt: number, isClosed = false): Connection {
  const conn = { id, pairedClientId, connectedAt, isClosed, clientId: id } as unknown as Connection
  connectionRegistry.add(conn)
  registered.push(conn)
  return conn
}

function caller(subject: string | null, pairedClientId: string | null = null): Connection {
  return { id: 'caller', pairedClientId, principal: subject ? { subject, displayName: subject } : null } as unknown as Connection
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-devices-'))
  _resetCredentialsStoreForTest(dir)
  const store = credentialsStore()
  store.add({ clientId: 'phone', secret: Buffer.alloc(32, 1), scopes: ['conversations:read'], subject: 'user:owner', kind: 'mobile', label: 'iPhone' })
  store.add({ clientId: 'laptop', secret: Buffer.alloc(32, 2), scopes: ['conversations:read', 'admin'], subject: 'user:owner', kind: 'desktop', label: 'laptop' })
  store.add({ clientId: 'fleet', secret: Buffer.alloc(32, 3), scopes: ['conversations:read'], subject: 'user:owner', kind: 'desktop', label: 'ion fleet on ops' })
  store.add({ clientId: 'other', secret: Buffer.alloc(32, 4), scopes: ['conversations:read'], subject: 'user:someone-else', kind: 'mobile' })
  store.add({ clientId: 'gone', secret: Buffer.alloc(32, 5), scopes: ['conversations:read'], subject: 'user:owner', kind: 'mobile' })
  store.revoke('gone')
})

afterEach(() => {
  for (const conn of registered.splice(0)) connectionRegistry.remove(conn)
  rmSync(dir, { recursive: true, force: true })
})

describe('connectedSince', () => {
  it('is the oldest open connection of the pairing, and null with none open', () => {
    const conns = [
      { pairedClientId: 'phone', isClosed: false, connectedAt: 300 },
      { pairedClientId: 'phone', isClosed: false, connectedAt: 200 },
      { pairedClientId: 'phone', isClosed: true, connectedAt: 100 },
      { pairedClientId: 'laptop', isClosed: false, connectedAt: 50 },
    ]
    expect(connectedSince('phone', conns)).toBe(200)
    expect(connectedSince('fleet', conns)).toBeNull()
  })
})

describe('environment.devices', () => {
  const devices = AUTH_ACTIONS['environment.devices']

  it('reads without admin', () => {
    expect(devices.requiredScope).toBe('conversations:read')
  })

  it('lists the caller\'s live pairings with their connection, marks the caller\'s own, and hides everyone else\'s', async () => {
    live('c1', 'phone', 1_000)
    live('c2', 'laptop', 2_000, true)
    const result = (await devices.handler(caller('user:owner', 'fleet'), [])) as { ok: true; value: Array<Record<string, unknown>> }
    expect(result.ok).toBe(true)
    const byId = Object.fromEntries(result.value.map((d) => [d.clientId, d]))
    expect(Object.keys(byId).sort()).toEqual(['fleet', 'laptop', 'phone'])
    expect(byId.phone).toMatchObject({ label: 'iPhone', kind: 'mobile', connected: true, connectedAt: 1_000, admin: false, self: false })
    expect(byId.laptop).toMatchObject({ connected: false, connectedAt: null, admin: true })
    expect(byId.fleet).toMatchObject({ self: true })
    expect(JSON.stringify(result.value)).not.toContain('secret')
  })

  it('refuses a connection that acts as nobody', async () => {
    expect(await devices.handler(caller(null), [])).toMatchObject({ ok: false, refusal: { code: 'no_principal' } })
  })
})

describe('auth.listClients', () => {
  it('carries each pairing\'s live connection', async () => {
    live('c1', 'other', 5_000)
    const result = (await AUTH_ACTIONS['auth.listClients'].handler(caller('user:owner'), [])) as { ok: true; value: Array<Record<string, unknown>> }
    const other = result.value.find((c) => c.clientId === 'other')!
    const phone = result.value.find((c) => c.clientId === 'phone')!
    expect(other).toMatchObject({ connected: true, connectedAt: 5_000 })
    expect(phone).toMatchObject({ connected: false, connectedAt: null })
  })
})
