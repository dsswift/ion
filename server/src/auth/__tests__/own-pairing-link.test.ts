/**
 * `auth.createOwnPairingLink`: a person without admin (a bearer sign-in on a
 * containerized server) mints a link for their OWN device. The device acts
 * as that person and gets only scopes that person holds, never admin.
 * `auth.createPairingLink` stays admin-only and unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHmac } from 'crypto'
import type { Scope } from '@ion/shared/studio-wire/types'
import { AUTH_ACTIONS, type AuthActionOutcome } from '../actions'
import { completePairing, _resetPairingLinksForTest } from '../pairing-links'
import { credentialsStore, _resetCredentialsStoreForTest } from '../credentials-store'
import { verifyPaired } from '../paired'
import { currentNonce, _resetNonceForTest } from '../nonce'
import { generateKeyPair } from '../../remote/crypto'
import { _resetCurrentServerConfigForTest, currentServerConfig, setCurrentServerConfig } from '../../config/current'
import { registerPrincipal, _resetPrincipalRegistryForTest } from '../../identity/principal-registry'
import type { Connection } from '../../protocol/connection'

/** A raw Entra `sub`, the subject the bearer door gives a signed-in person. */
const SUB = 'Qx3f9a2b7c-entra-sub'
const WEB_SCOPES: Scope[] = ['conversations:read', 'conversations:operate', 'terminal:operate', 'git:write']

let dir: string
let originalDataDir: string | undefined

beforeEach(() => {
  originalDataDir = process.env.ION_DATA_DIR
  dir = mkdtempSync(join(tmpdir(), 'ion-own-pairing-link-'))
  process.env.ION_DATA_DIR = dir
  _resetCredentialsStoreForTest(dir)
  _resetPrincipalRegistryForTest()
  _resetPairingLinksForTest()
  _resetCurrentServerConfigForTest()
  _resetNonceForTest()
  setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'isolated' }, pairing: { defaultScopes: [...WEB_SCOPES, 'admin'], advertiseUrl: 'https://studio.example.org' } })
})

afterEach(() => {
  _resetPairingLinksForTest()
  _resetCurrentServerConfigForTest()
  _resetPrincipalRegistryForTest()
  if (originalDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalDataDir
  rmSync(dir, { recursive: true, force: true })
})

function webCaller(scopes: Scope[] = WEB_SCOPES, subject: string | null = SUB): Connection {
  return { id: 'web-1', pairedClientId: null, clientId: null, scopes, principal: subject ? { subject, displayName: 'A Person', provider: 'login.microsoftonline.com', kind: 'operator', email: 'user@example.com' } : null } as unknown as Connection
}

async function mint(conn: Connection, args: Record<string, unknown> = { label: 'Phone' }): Promise<AuthActionOutcome> {
  return AUTH_ACTIONS['auth.createOwnPairingLink'].handler(conn, [args])
}

function complete(code: string, deviceId = 'dev-1'): string {
  const result = completePairing(credentialsStore(), { code, peerPublicKey: generateKeyPair().publicKey.toString('base64'), label: 'Phone', kind: 'mobile', deviceId })
  if (!result.ok) throw new Error(`pairing refused: ${result.reason}`)
  return result.clientId
}

describe('auth.createOwnPairingLink', () => {
  it('needs only conversations:read; auth.createPairingLink still needs admin', () => {
    expect(AUTH_ACTIONS['auth.createOwnPairingLink'].requiredScope).toBe('conversations:read')
    expect(AUTH_ACTIONS['auth.createPairingLink'].requiredScope).toBe('admin')
  })

  it('a non-admin bearer person mints a link; the device acts as them with their scopes, never admin', async () => {
    const outcome = await mint(webCaller())
    if (!outcome.ok || !('value' in outcome)) throw new Error(`mint refused: ${JSON.stringify(outcome)}`)
    const link = outcome.value as { url: string; code: string }
    expect(new URL(link.url).searchParams.get('url')).toBe('https://studio.example.org')

    const record = credentialsStore().get(complete(link.code))
    expect(record?.subject).toBe(SUB)
    expect(record?.scopes).toEqual(WEB_SCOPES)
    expect(record?.scopes).not.toContain('admin')
  })

  it('narrows the defaults to the scopes the caller holds', async () => {
    const outcome = await mint(webCaller(['conversations:read', 'git:write']))
    if (!outcome.ok || !('value' in outcome)) throw new Error('mint refused')
    const record = credentialsStore().get(complete((outcome.value as { code: string }).code))
    expect(record?.scopes).toEqual(['conversations:read', 'git:write'])
  })

  it('refuses explicit scopes the caller does not hold, admin included', async () => {
    expect(await mint(webCaller(['conversations:read']), { scopes: ['git:write'] })).toMatchObject({ ok: false, refusal: { code: 'scope' } })
    expect(await mint(webCaller(), { scopes: ['admin'] })).toMatchObject({ ok: false, refusal: { code: 'scope' } })
  })

  it('refuses naming another person or a relay', async () => {
    expect(await mint(webCaller(), { as: 'bob' })).toMatchObject({ ok: false, refusal: { code: 'admin_required' } })
    expect(await mint(webCaller(), { relay: true })).toMatchObject({ ok: false, refusal: { code: 'admin_required' } })
  })

  it('refuses a non-admin on a shared-tenancy install, where the device would act as the host', async () => {
    setCurrentServerConfig({ ...currentServerConfig(), tenancy: { mode: 'shared' } })
    expect(await mint(webCaller())).toMatchObject({ ok: false, refusal: { code: 'shared_tenancy' } })
  })

  it('refuses a connection that acts as no one', async () => {
    expect(await mint(webCaller(WEB_SCOPES, null))).toMatchObject({ ok: false, refusal: { code: 'no_principal' } })
  })

  it('the paired device, with no bearer, logs in as the signed-in person, not as its label', async () => {
    registerPrincipal({ subject: SUB, displayName: 'A Person', provider: 'login.microsoftonline.com', kind: 'operator', email: 'user@example.com' })
    const outcome = await mint(webCaller())
    if (!outcome.ok || !('value' in outcome)) throw new Error('mint refused')
    const clientId = complete((outcome.value as { code: string }).code)
    const secret = credentialsStore().secretFor(clientId)
    if (!secret) throw new Error('no secret')
    const proof = createHmac('sha256', secret).update(Buffer.from(currentNonce(), 'base64url')).digest('base64')
    const auth = await verifyPaired({ kind: 'paired', clientId, proof }, credentialsStore())
    expect(auth).toMatchObject({ ok: true, principal: { subject: SUB, displayName: 'A Person', kind: 'operator', email: 'user@example.com' }, scopes: WEB_SCOPES })
  })
})

describe('auth.createPairingLink (admin) is unchanged', () => {
  it('grants the full defaults, admin included, and pairs an unnamed device as itself', async () => {
    const admin = webCaller(['admin'], 'local:owner')
    const outcome = await AUTH_ACTIONS['auth.createPairingLink'].handler(admin, [{ label: 'Phone' }])
    if (!outcome.ok || !('value' in outcome)) throw new Error('mint refused')
    const record = credentialsStore().get(complete((outcome.value as { code: string }).code, 'dev-9'))
    expect(record?.scopes).toEqual([...WEB_SCOPES, 'admin'])
    expect(record?.subject).toBe('paired:dev-9')
  })
})
