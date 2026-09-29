/**
 * server-bearer -- a Sign in environment's token: one browser sign-in, then
 * the stored refresh token on every later connect, and never two browser
 * tabs for one environment at once. The identity provider is a fake that
 * answers discovery and the token endpoint.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))

import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { bearerTokenFor, clearBearerSignInCooldown } from '../server-bearer'
import { _setConnectionsFilePathForTest, loadCredential } from '../credentials'

let idp: Server
let issuer: string
let dir: string
let issued = 0
let refuseRefresh = false
const grants: string[] = []

beforeEach(async () => {
  issued = 0
  refuseRefresh = false
  grants.length = 0
  dir = mkdtempSync(join(tmpdir(), 'ion-server-bearer-'))
  _setConnectionsFilePathForTest(join(dir, 'desktop-connections.json'))
  idp = createServer((req, res) => {
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.url?.endsWith('/.well-known/openid-configuration')) {
      json(200, { authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` })
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf-8'))
      const grant = form.get('grant_type') ?? ''
      grants.push(grant)
      if (grant === 'refresh_token' && refuseRefresh) {
        json(400, { error: 'invalid_grant' })
        return
      }
      issued++
      json(200, { access_token: `access-${issued}`, refresh_token: `refresh-${issued}` })
    })
  })
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/t/v2.0`
})

afterEach(async () => {
  await new Promise<void>((resolve) => idp.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

const oidc = (): { issuer: string; audience: string; scope: string; clientId: string } => ({ issuer, audience: 'server-app', scope: 'Studio.Access', clientId: 'server-app' })

/** A browser that signs in at once and follows the redirect back. */
function browser(): { openUrl: (url: string) => Promise<void>; opened: string[] } {
  const opened: string[] = []
  return {
    opened,
    openUrl: async (url) => {
      opened.push(url)
      const authorize = new URL(url)
      const back = new URL(authorize.searchParams.get('redirect_uri')!)
      back.searchParams.set('code', 'code-1')
      back.searchParams.set('state', authorize.searchParams.get('state')!)
      await fetch(back)
    },
  }
}

describe('bearerTokenFor', () => {
  it('signs in once, then connects on the stored refresh token with no browser', async () => {
    const b = browser()
    expect(await bearerTokenFor('env-1', oidc(), { openUrl: b.openUrl })).toBe('access-1')
    expect(new URL(b.opened[0]).searchParams.get('scope')).toBe('openid offline_access api://server-app/Studio.Access')
    expect(JSON.parse(loadCredential('env-1')!.plaintext)).toEqual({ refreshToken: 'refresh-1' })

    expect(await bearerTokenFor('env-1', oidc(), { openUrl: b.openUrl })).toBe('access-2')
    expect(b.opened).toHaveLength(1)
    expect(grants).toEqual(['authorization_code', 'refresh_token'])
    expect(JSON.parse(loadCredential('env-1')!.plaintext)).toEqual({ refreshToken: 'refresh-2' })
  })

  it('signs in again when the stored refresh token is refused', async () => {
    const b = browser()
    await bearerTokenFor('env-1', oidc(), { openUrl: b.openUrl })
    refuseRefresh = true
    expect(await bearerTokenFor('env-1', oidc(), { openUrl: b.openUrl })).toBe('access-2')
    expect(b.opened).toHaveLength(2)
  })

  it('opens one browser tab for concurrent connects', async () => {
    const b = browser()
    const [first, second] = await Promise.all([bearerTokenFor('env-1', oidc(), { openUrl: b.openUrl }), bearerTokenFor('env-1', oidc(), { openUrl: b.openUrl })])
    expect(first).toBe(second)
    expect(b.opened).toHaveLength(1)
  })

  it('holds the browser shut after an abandoned sign-in until the person reconnects', async () => {
    await expect(bearerTokenFor('env-2', oidc(), { openUrl: async () => { throw new Error('no browser') } })).rejects.toThrow('no browser')
    const b = browser()
    await expect(bearerTokenFor('env-2', oidc(), { openUrl: b.openUrl })).rejects.toThrow(/did not finish/)
    expect(b.opened).toHaveLength(0)
    clearBearerSignInCooldown('env-2')
    expect(await bearerTokenFor('env-2', oidc(), { openUrl: b.openUrl })).toBe('access-1')
  })
})
