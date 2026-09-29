/**
 * server-sign-in -- the desktop signs in as the server's own app, against a
 * fake identity provider that answers discovery and the token endpoint. The
 * "browser" is the openUrl hook: it follows the authorize URL straight back
 * to the loopback listener, the way Entra redirects after sign-in.
 */
import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { signInToServer } from '../server-sign-in'

let idp: Server
let issuer: string
const tokenBodies: URLSearchParams[] = []

beforeEach(async () => {
  tokenBodies.length = 0
  idp = createServer((req, res) => {
    if (req.url === '/tenant/v2.0/.well-known/openid-configuration') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer.replace('/tenant/v2.0', '')}/token` }))
      return
    }
    if (req.method === 'POST' && req.url === '/token') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body = new URLSearchParams(Buffer.concat(chunks).toString('utf-8'))
        tokenBodies.push(body)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ access_token: `token-for-${body.get('code')}` }))
      })
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => idp.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/tenant/v2.0`
})

afterEach(async () => {
  await new Promise<void>((resolve) => idp.close(() => resolve()))
})

const SERVER = { audience: 'instance-app', scope: 'Studio.Access', clientId: 'instance-app' }

/** A browser that signs in instantly and follows the redirect back with `code`, echoing or replacing the state. */
function browser(code: string, state?: string): (url: string) => Promise<void> {
  return async (url) => {
    const authorize = new URL(url)
    const back = new URL(authorize.searchParams.get('redirect_uri')!)
    back.searchParams.set('code', code)
    back.searchParams.set('state', state ?? authorize.searchParams.get('state')!)
    opened.push(authorize)
    await fetch(back)
  }
}
const opened: URL[] = []

describe('signInToServer', () => {
  it('signs in as the server app with PKCE and no secret, and returns the token', async () => {
    opened.length = 0
    const token = await signInToServer({ issuer, ...SERVER }, { openUrl: browser('abc') })
    expect(token).toBe('token-for-abc')

    const authorize = opened[0]
    expect(authorize.searchParams.get('client_id')).toBe('instance-app')
    expect(authorize.searchParams.get('scope')).toBe('openid api://instance-app/Studio.Access')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('redirect_uri')).toMatch(/^http:\/\/localhost:\d+\/callback$/)

    const exchange = tokenBodies[0]
    expect(exchange.get('client_id')).toBe('instance-app')
    expect(exchange.get('grant_type')).toBe('authorization_code')
    expect(exchange.get('redirect_uri')).toBe(authorize.searchParams.get('redirect_uri'))
    expect(exchange.get('code_verifier')).toBeTruthy()
    expect(exchange.has('client_secret')).toBe(false)
  })

  it('falls back to the audience when the server names no sign-in app', async () => {
    opened.length = 0
    await signInToServer({ issuer, audience: 'instance-app', scope: 'Studio.Access', clientId: '' }, { openUrl: browser('x') })
    expect(opened[0].searchParams.get('client_id')).toBe('instance-app')
  })

  it('refuses a callback carrying the wrong state', async () => {
    await expect(signInToServer({ issuer, ...SERVER }, { openUrl: browser('abc', 'forged') })).rejects.toThrow(/wrong state/)
    expect(tokenBodies).toEqual([])
  })

  it('gives up when the browser never comes back', async () => {
    await expect(signInToServer({ issuer, ...SERVER }, { openUrl: async () => undefined, timeoutMs: 50 })).rejects.toThrow(/timed out/)
  })
})
