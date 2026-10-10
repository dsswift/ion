/**
 * A server and a hub, end to end over a real socket: enrollment, reports,
 * actions, removal, and the gate in front of the hub's pages and API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket from 'ws'
import type { HubEnrollmentToken, HubFleet } from '@ion/shared/fleet-hub'
import type { FleetReport } from '@ion/shared/types-fleet'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))
const refresh = vi.hoisted(() => vi.fn())
vi.mock('../../auth/browser-oidc', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../auth/browser-oidc')>()), refreshAccessToken: refresh }))

import { startHub, type HubHandle } from '../main'
import type { HubConfig } from '../config'
import { HubLink, type HubLinkOptions } from '../../fleet/hub-link'
import { BrowserSessionStore, newSessionId } from '../../auth/browser-session-store'

const TOKEN = 'enroll-me'
const report = (accounts = 1): FleetReport => ({ generatedAt: 1, server: { serverVersion: '1.0.0' }, metrics: null, devices: { paired: 0, connected: 0 }, providers: [], defaultProvider: '', modelTiers: [], accounts: Array.from({ length: accounts }, () => ({})) } as unknown as FleetReport)

let dir: string
let hub: HubHandle
let links: HubLink[]
let base: string

async function boot(config: Partial<HubConfig> = {}): Promise<void> {
  hub = startHub({ dir, webDir: dir, config: { label: 'Test hub', listen: { port: 0, host: '127.0.0.1' }, oidc: null, enrollmentTokens: [TOKEN], enrollmentTokenMinutes: 30, views: { quota: true }, ...config } })
  await new Promise<void>((resolve) => hub.server.once('listening', () => resolve()))
  base = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`
}

function link(over: Partial<HubLinkOptions> = {}): { link: HubLink; credential: { value: string | null }; ran: Array<[string, unknown[]]> } {
  const credential = { value: null as string | null }
  const ran: Array<[string, unknown[]]> = []
  const made = new HubLink({
    url: base,
    manage: true,
    enrollmentToken: TOKEN,
    environmentId: 'env-1',
    label: 'server one',
    reportSeconds: 3600,
    credential: () => credential.value,
    saveCredential: (c) => { credential.value = c },
    clearCredential: () => { credential.value = null },
    buildReport: async () => report(),
    runAction: async (action, args) => { ran.push([action, args]); return { ok: true, value: { done: action } } },
    ...over,
  })
  links.push(made)
  made.start()
  return { link: made, credential, ran }
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const fleet = async (headers: Record<string, string> = {}): Promise<HubFleet> => (await fetch(`${base}/api/fleet`, { headers })).json() as Promise<HubFleet>
const act = (id: string, body: unknown, headers: Record<string, string> = { 'x-ion-hub': '1' }): Promise<Response> =>
  fetch(`${base}/api/servers/${id}/actions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

const issue = (headers: Record<string, string> = { 'x-ion-hub': '1' }): Promise<Response> => fetch(`${base}/api/enrollment-tokens`, { method: 'POST', headers })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ion-hub-test-'))
  links = []
})
afterEach(async () => {
  for (const l of links) l.close()
  await hub.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('a server reporting to a hub', () => {
  it('tells its page which views to show, as hub.json sets them', async () => {
    await boot({ views: { quota: false } })
    expect((await fleet()).hub.views).toEqual({ quota: false })
  })

  it('enrolls with the token, is issued a credential, and its report shows on the hub', async () => {
    await boot()
    const { link: l, credential } = link()
    await until(async () => (await fleet()).servers[0]?.report != null, 'the report')
    const got = await fleet()
    expect(got.hub).toEqual({ label: 'Test hub', authRequired: false, canManage: true, views: { quota: true } })
    expect(got.servers).toHaveLength(1)
    expect(got.servers[0]).toMatchObject({ id: 'env-1', label: 'server one', online: true, manage: true })
    expect(credential.value).toBeTruthy()
    expect(l.status()).toMatchObject({ state: 'connected', hubLabel: 'Test hub' })
  })

  it('says how joining went once the hub has answered, not that it started', async () => {
    await boot()
    const { link: l } = link()
    expect(l.status().state).toBe('connecting')
    await l.settled(5_000)
    expect(l.status().state).toBe('connected')
    const refused = link({ environmentId: 'env-2', enrollmentToken: 'not-it' })
    await refused.link.settled(5_000)
    expect(refused.link.status().state).toBe('refused')
  })

  it('comes back with its credential, and keeps its last report while it is away', async () => {
    await boot()
    const first = link()
    await until(async () => (await fleet()).servers[0]?.report != null, 'the report')
    first.link.close()
    await until(async () => (await fleet()).servers[0]?.online === false, 'the server going offline')
    expect((await fleet()).servers[0].report).not.toBeNull()
    // The token is gone from this link: only the credential can let it back in.
    const again = link({ enrollmentToken: 'wrong', credential: () => first.credential.value })
    await until(() => again.link.status().state === 'connected', 'the reconnect')
    expect((await fleet()).servers).toHaveLength(1)
  })

  it('is turned away with a token the hub does not accept', async () => {
    await boot()
    const { link: l } = link({ enrollmentToken: 'not-it' })
    await until(() => l.status().state === 'refused', 'the refusal')
    expect(l.status().detail).toContain('enrollment token')
    expect((await fleet()).servers).toEqual([])
  })

  it('runs an action the hub asks for, and only one a hub may ask for', async () => {
    await boot()
    const { ran } = link()
    await until(async () => (await fleet()).servers[0]?.online === true, 'the server')
    const ok = await (await act('env-1', { action: 'fleet.refreshAccounts' })).json()
    expect(ok).toEqual({ ok: true, value: { done: 'fleet.refreshAccounts' } })
    expect(ran).toEqual([['fleet.refreshAccounts', []]])
    expect((await act('env-1', { action: 'provider.login' })).status).toBe(400)
    expect((await act('nope', { action: 'fleet.refreshAccounts' })).status).toBe(404)
    // A page of another site cannot send the intent header, or names another origin.
    expect((await act('env-1', { action: 'fleet.refreshAccounts' }, {})).status).toBe(403)
    expect((await act('env-1', { action: 'fleet.refreshAccounts' }, { 'x-ion-hub': '1', origin: 'https://elsewhere.example.org' })).status).toBe(403)
    expect(ran).toHaveLength(1)
  })

  it('does not run an action on a link that only reports', async () => {
    await boot()
    const { ran } = link({ manage: false })
    await until(async () => (await fleet()).servers[0]?.online === true, 'the server')
    expect((await fleet()).servers[0].manage).toBe(false)
    expect(await (await act('env-1', { action: 'environment.server.restart' })).json()).toMatchObject({ ok: false })
    expect(ran).toEqual([])
  })

  it('shows under the name given on the hub, which outlives the server\'s own', async () => {
    await boot()
    const first = link()
    await until(async () => (await fleet()).servers[0]?.online === true, 'the server')
    const patch = (label: unknown, headers: Record<string, string> = { 'x-ion-hub': '1' }): Promise<Response> =>
      fetch(`${base}/api/servers/env-1`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ label }) })
    expect((await patch('win-arm64', {})).status).toBe(403)
    expect((await patch('win-arm64')).status).toBe(200)
    expect((await fleet()).servers[0]).toMatchObject({ label: 'win-arm64', reportedLabel: 'server one' })
    // The server comes back, still calling itself what it always did.
    first.link.close()
    const again = link({ credential: () => first.credential.value })
    await until(() => again.link.status().state === 'connected', 'the reconnect')
    expect((await fleet()).servers[0]).toMatchObject({ label: 'win-arm64', reportedLabel: 'server one' })
    // An empty name goes back to the server's own.
    expect((await patch('')).status).toBe(200)
    const back = (await fleet()).servers[0]
    expect(back.label).toBe('server one')
    expect(back.reportedLabel).toBeUndefined()
    expect((await patch(7)).status).toBe(400)
  })

  it('is forgotten when the hub removes it, and does not rejoin by itself', async () => {
    await boot()
    const { link: l, credential } = link()
    await until(async () => (await fleet()).servers[0]?.online === true, 'the server')
    expect((await fetch(`${base}/api/servers/env-1`, { method: 'DELETE', headers: { 'x-ion-hub': '1' } })).status).toBe(200)
    await until(() => l.status().state === 'refused', 'the refusal')
    expect(l.status().detail).toContain('removed')
    expect(credential.value).toBeNull()
    expect((await fleet()).servers).toEqual([])
  })
})

describe('an enrollment token made on the hub\'s page', () => {
  it('lets one server join a hub that has none in hub.json, and no second server after it', async () => {
    await boot({ enrollmentTokens: [] })
    const issued = await (await issue()).json() as HubEnrollmentToken
    expect(issued.token.length).toBeGreaterThan(20)
    expect(issued.expiresAt).toBeGreaterThan(Date.now())
    const first = link({ enrollmentToken: issued.token })
    await until(() => first.link.status().state === 'connected', 'the first server')
    expect(first.credential.value).toBeTruthy()
    const second = link({ enrollmentToken: issued.token, environmentId: 'env-2', label: 'server two' })
    await until(() => second.link.status().state === 'refused', 'the second server to be turned away')
    expect((await fleet()).servers.map((s) => s.id)).toEqual(['env-1'])
  })

  it('is a new one each time, and is made only for the hub\'s own page', async () => {
    await boot()
    const one = await (await issue()).json() as HubEnrollmentToken
    const two = await (await issue()).json() as HubEnrollmentToken
    expect(one.token).not.toBe(two.token)
    expect((await issue({})).status).toBe(403)
    expect((await issue({ 'x-ion-hub': '1', origin: 'https://elsewhere.example.org' })).status).toBe(403)
    expect((await fetch(`${base}/api/enrollment-tokens`, { headers: { 'x-ion-hub': '1' } })).status).toBe(405)
  })

  it('stops working once its time is up', async () => {
    await boot({ enrollmentTokens: [], enrollmentTokenMinutes: 0 })
    const issued = await (await issue()).json() as HubEnrollmentToken
    const { link: l } = link({ enrollmentToken: issued.token })
    await until(() => l.status().state === 'refused', 'the server to be turned away')
  })

  it('still works after the hub restarts', async () => {
    await boot({ enrollmentTokens: [] })
    const issued = await (await issue()).json() as HubEnrollmentToken
    await hub.close()
    await boot({ enrollmentTokens: [] })
    const { link: l } = link({ enrollmentToken: issued.token })
    await until(() => l.status().state === 'connected', 'the server')
  })
})

describe('a server that misbehaves', () => {
  /** A raw agent socket, enrolled as `id`. */
  async function rawAgent(id: string): Promise<WebSocket> {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/v1/agent`)
    await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject) })
    const welcomed = new Promise<void>((resolve) => ws.once('message', () => resolve()))
    ws.send(JSON.stringify({ type: 'hub_hello', protocol: 1, environmentId: id, label: id, manage: true, enrollmentToken: TOKEN }))
    await welcomed
    return ws
  }

  it('cannot take the hub down with a report that is not one', async () => {
    await boot()
    const ws = await rawAgent('env-bad')
    ws.send(JSON.stringify({ type: 'hub_report' }))
    ws.send(JSON.stringify({ type: 'hub_report', report: 'nope' }))
    ws.send(JSON.stringify({ type: 'hub_report', report: { accounts: 3 } }))
    ws.send('null')
    ws.send(JSON.stringify({ type: 'hub_report', report: report(2) }))
    await until(async () => (await fleet()).servers[0]?.report != null, 'the good report')
    expect((await fleet()).servers[0].report?.accounts).toHaveLength(2)
    ws.close()
  })

  it('cannot answer an action the hub asked another server', async () => {
    await boot()
    const asked = await rawAgent('env-asked')
    const other = await rawAgent('env-other')
    const actionId = new Promise<string>((resolve) => asked.once('message', (raw) => resolve((JSON.parse(String(raw)) as { id: string }).id)))
    const answer = act('env-asked', { action: 'fleet.refreshAccounts' }).then((r) => r.json())
    const id = await actionId
    other.send(JSON.stringify({ type: 'hub_action_result', id, ok: true, value: 'forged' }))
    // The forged answer is read first: frames on one hub are handled in the order they arrive.
    await new Promise((resolve) => setTimeout(resolve, 50))
    asked.send(JSON.stringify({ type: 'hub_action_result', id, ok: true, value: 'real' }))
    expect(await answer).toEqual({ ok: true, value: 'real' })
    asked.close()
    other.close()
  })

  it('has its waiting action answered at once when the hub removes it', async () => {
    await boot()
    const ws = await rawAgent('env-gone')
    const asked = new Promise<void>((resolve) => ws.once('message', () => resolve()))
    const answer = act('env-gone', { action: 'fleet.refreshAccounts' }).then((r) => r.json())
    await asked
    expect((await fetch(`${base}/api/servers/env-gone`, { method: 'DELETE', headers: { 'x-ion-hub': '1' } })).status).toBe(200)
    expect(await answer).toMatchObject({ ok: false, error: expect.stringContaining('removed') })
    ws.close()
  })
})

describe('a deploy and an install as a hub sees them', () => {
  const deploy = { id: 'd1', source: 'build of ion', startedAt: 10, updatedAt: 10, state: 'running' as const, targets: [{ host: 'win-1', label: 'Win one', environmentId: 'env-9', stage: 'building', detail: 'building on win-1', updatedAt: 10 }] }

  it('shows a deploy the moment the deploying machine\'s server passes it on, and each step after', async () => {
    await boot()
    const { link: l } = link()
    await until(() => l.status().state === 'connected', 'the link')
    expect(l.sendDeploy(deploy)).toBe(true)
    await until(async () => (await fleet()).deploys.length === 1, 'the deploy')
    expect((await fleet()).deploys[0]).toMatchObject({ id: 'd1', state: 'running', reportedBy: { id: 'env-1', label: 'server one' }, targets: [{ host: 'win-1', stage: 'building' }] })
    l.sendDeploy({ ...deploy, updatedAt: 20, endedAt: 20, state: 'failed', targets: [{ ...deploy.targets[0], stage: 'failed', detail: undefined, error: 'the build on win-1 failed', updatedAt: 20 }] })
    await until(async () => (await fleet()).deploys[0]?.state === 'failed', 'the outcome')
    expect((await fleet()).deploys[0].targets[0]).toMatchObject({ stage: 'failed', error: 'the build on win-1 failed' })
  })

  it('shows a server\'s own install steps on that server, and keeps both across a hub restart', async () => {
    await boot()
    const { link: l } = link()
    await until(() => l.status().state === 'connected', 'the link')
    l.sendDeploy(deploy)
    l.sendInstall({ stage: 'restarting', kind: 'artifact', at: 5 })
    await until(async () => (await fleet()).servers[0]?.install?.stage === 'restarting', 'the install step')
    l.close()
    await hub.close()
    await boot()
    const again = await fleet()
    expect(again.servers[0]).toMatchObject({ online: false, install: { stage: 'restarting', kind: 'artifact' } })
    expect(again.deploys).toMatchObject([{ id: 'd1' }])
  })

  it('is told what still stands by a server that connects after it began', async () => {
    await boot()
    link({ standing: () => ({ deploys: [deploy], install: { stage: 'completed', kind: 'release', version: '2.0.0', at: 7 } }) })
    await until(async () => (await fleet()).deploys.length === 1 && (await fleet()).servers[0]?.install != null, 'the standing state')
    expect((await fleet()).servers[0].install).toMatchObject({ stage: 'completed', version: '2.0.0' })
  })

  it('drops a frame that is not a deploy record or an install step', async () => {
    await boot()
    const { link: l } = link()
    await until(() => l.status().state === 'connected', 'the link')
    l.sendDeploy({ id: 'bad' } as never)
    l.sendInstall({ stage: 'exploded', kind: 'release', at: 1 } as never)
    l.sendDeploy(deploy)
    await until(async () => (await fleet()).deploys.length === 1, 'the good deploy')
    const got = await fleet()
    expect(got.deploys.map((d) => d.id)).toEqual(['d1'])
    expect(got.servers[0].install).toBeUndefined()
  })
})

describe('a hub with a sign-in', () => {
  const oidc = { issuer: 'https://login.example.org/t', audience: 'api://hub', scope: 'Hub.Access', clientId: 'client', rolesToScopes: {}, defaultScopes: [], allowedSubjects: [], clientSecret: '' }

  function session(scopes: string[]): string {
    const sessionId = newSessionId()
    new BrowserSessionStore(dir).create({ sessionId, principal: { subject: 'sub-1', displayName: 'A Person', provider: 'entra', kind: 'operator' }, scopes: scopes as never, accessToken: 't', refreshToken: null, accessExpiresAt: Date.now() + 3_600_000 })
    return `ion_session=${sessionId}`
  }

  it('answers nothing but health and sign-in to someone not signed in', async () => {
    await boot({ oidc })
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
    expect((await fetch(`${base}/api/fleet`)).status).toBe(401)
    expect((await fetch(`${base}/api/events`)).status).toBe(401)
    const page = await fetch(`${base}/servers`, { redirect: 'manual' })
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('/auth/login?returnTo=%2Fservers')
    const asset = await fetch(`${base}/assets/hub.js`, { redirect: 'manual' })
    expect(asset.status).toBe(302)
    expect((await act('env-1', { action: 'fleet.refreshAccounts' })).status).toBe(401)
    expect((await issue()).status).toBe(401)
  })

  it('shows the Fleet to anyone signed in, and lets only an admin act', async () => {
    await boot({ oidc })
    const { ran } = link()
    const reader = { cookie: session(['conversations:read']) }
    const admin = { cookie: session(['admin']) }
    await until(async () => (await fleet(reader)).servers[0]?.online === true, 'the server')
    expect((await fleet(reader)).hub).toEqual({ label: 'Test hub', authRequired: true, user: 'A Person', canManage: false, views: { quota: true } })
    expect((await act('env-1', { action: 'fleet.refreshAccounts' }, { 'x-ion-hub': '1', ...reader })).status).toBe(403)
    expect(ran).toEqual([])
    expect((await issue({ 'x-ion-hub': '1', ...reader })).status).toBe(403)
    expect((await issue({ 'x-ion-hub': '1', ...admin })).status).toBe(200)
    expect((await fleet(admin)).hub.canManage).toBe(true)
    expect(await (await act('env-1', { action: 'fleet.refreshAccounts' }, { 'x-ion-hub': '1', ...admin })).json()).toMatchObject({ ok: true })
    expect(ran).toHaveLength(1)
  })

  it('refreshes a session once for a page that asks for many things at once', async () => {
    await boot({ oidc })
    const sessionId = newSessionId()
    new BrowserSessionStore(dir).create({ sessionId, principal: { subject: 'sub-1', displayName: 'A Person', provider: 'entra', kind: 'operator' }, scopes: ['admin'] as never, accessToken: 't', refreshToken: 'r1', accessExpiresAt: Date.now() + 1_000 })
    const cookie = { cookie: `ion_session=${sessionId}` }
    refresh.mockReset().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { ok: true, auth: { ok: true, principal: { subject: 'sub-1', displayName: 'A Person', provider: 'entra', kind: 'operator' }, scopes: ['admin'], expiresAt: Date.now() + 3_600_000 }, accessToken: 't2', refreshToken: 'r2' }
    })
    const answers = await Promise.all([fleet(cookie), fleet(cookie), fleet(cookie), fleet(cookie)])
    expect(answers.every((a) => a.hub?.user === 'A Person')).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('still lets a server enroll: a server proves itself with its token, not a sign-in', async () => {
    await boot({ oidc })
    const { link: l } = link()
    await until(() => l.status().state === 'connected', 'the enrollment')
  })
})
