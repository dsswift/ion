/**
 * `device.registerPush`: a paired phone tells the server where it receives
 * pushes. The address lands on that phone's own pairing record, from any
 * transport, and never leaves the server through the devices list.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AUTH_ACTIONS } from '../actions'
import { credentialsStore, _resetCredentialsStoreForTest } from '../credentials-store'
import type { Connection } from '../../protocol/connection'

const token = 'ab'.repeat(32)
let dir: string

function conn(pairedClientId: string | null): Connection {
  return { id: 'conn-1', pairedClientId } as Connection
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-register-push-'))
  _resetCredentialsStoreForTest(dir)
  credentialsStore().add({ clientId: 'phone', secret: Buffer.alloc(32, 1), scopes: ['conversations:read'], subject: 'local:owner', kind: 'mobile' })
  credentialsStore().add({ clientId: 'desk', secret: Buffer.alloc(32, 2), scopes: ['conversations:read'], subject: 'local:owner', kind: 'desktop' })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('AUTH_ACTIONS device.registerPush', () => {
  const register = AUTH_ACTIONS['device.registerPush'].handler

  it('records the address on the calling phone\'s own pairing, and replaces it on change', async () => {
    expect(await register(conn('phone'), [{ token, env: 'sandbox' }])).toEqual({ ok: true, value: true })
    expect(credentialsStore().get('phone')?.push).toMatchObject({ token, env: 'sandbox' })

    const next = 'cd'.repeat(32)
    await register(conn('phone'), [{ token: next.toUpperCase(), env: 'production' }])
    expect(credentialsStore().get('phone')?.push).toMatchObject({ token: next, env: 'production' })
  })

  it('refuses a connection that is not a paired phone', async () => {
    expect(await register(conn(null), [{ token, env: 'sandbox' }])).toMatchObject({ ok: false, refusal: { code: 'not_paired' } })
    expect(await register(conn('desk'), [{ token, env: 'sandbox' }])).toMatchObject({ ok: false, refusal: { code: 'not_a_phone' } })
    credentialsStore().revoke('phone')
    expect(await register(conn('phone'), [{ token, env: 'sandbox' }])).toMatchObject({ ok: false, refusal: { code: 'not_a_phone' } })
  })

  it('refuses a malformed token or environment', async () => {
    expect(await register(conn('phone'), [{ token: 'not-hex', env: 'sandbox' }])).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(await register(conn('phone'), [{ token, env: 'development' }])).toMatchObject({ ok: false, error: { code: 'invalid_args' } })
    expect(credentialsStore().get('phone')?.push).toBeUndefined()
  })

  it('keeps the token out of the devices list', async () => {
    await register(conn('phone'), [{ token, env: 'sandbox' }])
    const listed = (await AUTH_ACTIONS['auth.listClients'].handler(conn(null), [])) as { ok: true; value: Array<Record<string, unknown>> }
    const phone = listed.value.find((client) => client.clientId === 'phone')!
    expect(phone.push).toEqual({ env: 'sandbox', updatedAt: expect.any(Number) })
    expect(JSON.stringify(listed.value)).not.toContain(token)
  })

  it('takes the lowest authenticated scope, since a phone only ever writes its own pairing', () => {
    expect(AUTH_ACTIONS['device.registerPush'].requiredScope).toBe('conversations:read')
  })
})
