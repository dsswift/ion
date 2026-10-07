/**
 * Hosted personal instance, end to end against the REAL engine: a server with
 * `homeProject` and an OIDC issuer, the engine reading an enterprise policy
 * file with `newConversationDefaults.locked`, and one signed-in person.
 *
 * Proves three things a unit test cannot:
 *   1. a fresh boot presents the signed-in person no conversation they cannot
 *      send to (there is none until they open one);
 *   2. a conversation they open lands in the home project on the `orion`
 *      profile, whatever directory they ask for;
 *   3. the policy file carrying the lock is read by the engine with no
 *      `orion` profile on disk yet, and the server's boot writes that profile.
 *
 * Own file, own data dir: the engine and server here need a `server.json`
 * with `oidc`, which `server-engine.test.ts` deliberately does not have.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import WebSocket from 'ws'
import { generateKeyPair, exportJWK, calculateJwkThumbprint, SignJWT } from 'jose'
import { createServer, type Server } from 'http'
import { startEngine, cleanupEngineDataDir, type EngineHandle } from './engine-harness'
import { closeSocket, helloFrame, nextFrame, sendFrame, waitOpen } from '../../src/protocol/__tests__/harness'
import type { ServerHandle } from '../../src/main'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import type { AddressInfo } from 'net'

const dataDir = process.env.ION_DATA_DIR
if (!dataDir) throw new Error('ION_DATA_DIR was not set by setup-data-dir.ts')

const HOME = join(dataDir, 'home', 'jdoe')
const ORION = join(HOME, 'orion')
const AUDIENCE = 'hosted-instance-audience'
const SUBJECT = 'entra-sub-owner'

let engine: EngineHandle
let server: ServerHandle
let idp: Server
let issuer = ''
let signingKey: CryptoKey
let kid = ''
let tcpPort = 0

async function startIdp(): Promise<void> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  signingKey = privateKey
  const jwk = await exportJWK(publicKey)
  kid = await calculateJwkThumbprint(jwk)
  Object.assign(jwk, { kid, alg: 'RS256', use: 'sig' })
  idp = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (req.url === '/.well-known/jwks.json') res.end(JSON.stringify({ keys: [jwk] }))
    else if (req.url === '/.well-known/openid-configuration') res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/.well-known/jwks.json` }))
    else { res.writeHead(404); res.end() }
  })
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`
}

function bearer(): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ scp: 'Studio.Access' })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuedAt(now).setSubject(SUBJECT).setIssuer(issuer).setAudience(AUDIENCE).setExpirationTime(now + 300)
    .sign(signingKey)
}

async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function signIn(): Promise<{ ws: WebSocket; welcome: Extract<StudioFrame, { type: 'studio_welcome' }> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${tcpPort}`)
  await waitOpen(ws)
  sendFrame(ws, helloFrame({ clientKind: 'web', credential: { kind: 'bearer', token: await bearer() } }))
  const frame = await nextFrame(ws, 10000)
  if (frame.type !== 'studio_welcome') throw new Error(`expected studio_welcome, got ${frame.type}: ${JSON.stringify(frame)}`)
  return { ws, welcome: frame }
}

/** Sends one action and returns its result, skipping every other frame the server pushes meanwhile. */
async function act(ws: WebSocket, action: string, args: unknown[]): Promise<Extract<StudioFrame, { type: 'studio_action_result' }>> {
  const id = `act-${Math.random().toString(36).slice(2, 8)}`
  sendFrame(ws, { type: 'studio_action', id, action, args } as StudioFrame)
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const frame = await nextFrame(ws, 30000)
    if (frame.type === 'studio_action_result' && frame.id === id) return frame
  }
  throw new Error(`no result for ${action}`)
}

beforeAll(async () => {
  mkdirSync(ORION, { recursive: true })
  await startIdp()

  // The lock policy the infra overlay mounts. No `orion` profile exists anywhere yet.
  const policyPath = join(dataDir, 'enterprise.json')
  writeFileSync(policyPath, JSON.stringify({ newConversationDefaults: { baseDirectory: ORION, engineProfileId: 'orion', locked: true } }))
  process.env.ION_ENTERPRISE_CONFIG = policyPath
  engine = await startEngine({ dataDir, socketWaitMs: 20000 })

  writeFileSync(join(dataDir, 'server.json'), JSON.stringify({
    listen: { local: false, tcp: { host: '127.0.0.1', port: 0 } },
    web: { enabled: false },
    oidc: { issuer, audience: AUDIENCE, clientId: AUDIENCE, scope: 'Studio.Access', rolesToScopes: {}, defaultScopes: ['conversations:read', 'conversations:operate', 'terminal:operate', 'git:write'] },
    tenancy: { unownedTabs: 'visible' },
    homeProject: { directory: ORION, gitRemote: 'git@example.com:team/ops.git', engineProfile: { name: 'orion', extensions: [join(dataDir, 'ext', 'main')], defaultMode: 'auto' } },
  }))
  const { main } = await import('../../src/main')
  server = await main()
  await waitFor(() => server.getReadiness().ready === true, 20000, 'server ready')
  tcpPort = (server.tcpServer?.address() as AddressInfo).port
}, 60000)

afterAll(async () => {
  await server?.close()
  await engine?.stop()
  await new Promise<void>((resolve) => idp.close(() => resolve()))
  cleanupEngineDataDir(dataDir)
}, 20000)

describe('hosted personal instance with a home project and the lock policy', () => {
  it('writes the orion profile and registers the home project as default at boot', () => {
    const settings = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf-8'))
    expect(settings.defaultBaseDirectory).toBe(ORION)
    expect(settings.engineProfiles.map((p: { id: string }) => p.id)).toContain('orion')
    expect(settings.projects[ORION].isDefault).toBe(true)
  })

  it('opens no conversation before sign-in, then gives the person one they own in the home project on first sign-in', async () => {
    const { ws, welcome } = await signIn()
    expect(welcome.snapshot.tabs).toEqual([])
    expect(welcome.enterprisePolicy?.newConversationDefaults).toMatchObject({ baseDirectory: ORION, engineProfileId: 'orion', locked: true })
    const readTabs = (): Array<{ workingDirectory: string; engineProfileId?: string; principalSubject?: string }> => {
      try { return JSON.parse(readFileSync(join(dataDir, 'tabs.json'), 'utf-8')).tabs } catch { return [] }
    }
    await waitFor(() => readTabs().length > 0, 10000, 'first conversation persisted')
    expect(readTabs()).toEqual([expect.objectContaining({ workingDirectory: ORION, engineProfileId: 'orion', principalSubject: SUBJECT })])
    await closeSocket(ws)
  })

  it('opens a conversation asked for in $HOME in the home project on the orion profile, owned by the person', async () => {
    const { ws } = await signIn()
    const result = await act(ws, 'createConversationTab', [HOME, { profileId: '' }])
    expect(result.ok).toBe(true)
    const tabId = result.value as string
    await waitFor(() => {
      try { return JSON.parse(readFileSync(join(dataDir, 'tabs.json'), 'utf-8')).tabs.some((t: { id: string }) => t.id === tabId) } catch { return false }
    }, 10000, 'tab persisted')
    const tab = JSON.parse(readFileSync(join(dataDir, 'tabs.json'), 'utf-8')).tabs.find((t: { id: string }) => t.id === tabId)
    expect(tab.workingDirectory).toBe(ORION)
    expect(tab.engineProfileId).toBe('orion')
    expect(tab.principalSubject).toBe(SUBJECT)
    await closeSocket(ws)
  })

  it('refuses project creation and a directory change under the lock', async () => {
    const { ws } = await signIn()
    const add = await act(ws, 'environment.projects.add', [{ dir: HOME }])
    expect(add.ok).toBe(false)
    expect(add.refusal?.code).toBe('policy_locked')
    const base = await act(ws, 'setBaseDirectory', [HOME])
    expect(base.ok).toBe(false)
    expect(base.refusal?.code).toBe('policy_locked')
    await closeSocket(ws)
  })
})
