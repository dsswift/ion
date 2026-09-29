import { afterEach, describe, expect, it } from 'vitest'
import { startHealth, type HealthHandle } from '../health'
import { authConfigRoute } from '../auth-config'
import type { ServerOidcConfig } from '../../config/server-config'

let health: HealthHandle | null = null

afterEach(async () => {
  if (health) await health.close()
  health = null
})

function baseUrl(h: HealthHandle): string {
  const address = h.tcpServer?.address()
  if (!address || typeof address === 'string') throw new Error('expected an AddressInfo from the ephemeral TCP listener')
  return `http://127.0.0.1:${address.port}`
}

describe('GET /auth/config', () => {
  it('reads the environment id at request time, so an id minted after the route table was built is what a pairing learns', async () => {
    const runtime = { id: 'boot-1' }
    health = startHealth({
      port: 0,
      routes: { '/auth/config': authConfigRoute({ getOidc: () => null, getEnvironmentId: () => runtime.id, label: 'L', serverVersion: '0' }) },
    })
    runtime.id = 'real-id'
    const body = await (await fetch(`${baseUrl(health)}/auth/config`)).json() as { environmentId: string }
    expect(body.environmentId).toBe('real-id')
  })

  it('returns manifest C6 shape with oidc null when server.json has no oidc block', async () => {
    health = startHealth({
      port: 0,
      routes: {
        '/auth/config': authConfigRoute({ getOidc: () => null, getEnvironmentId: () => 'env-123', label: 'Test Server', serverVersion: '0.1.0-test' }),
      },
    })
    const res = await fetch(`${baseUrl(health)}/auth/config`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      oidc: null,
      transports: ['local', 'paired', 'bearer'],
      environmentId: 'env-123',
      label: 'Test Server',
      serverVersion: '0.1.0-test',
    })
    expect(typeof body.protocolVersion).toBe('number')
    expect(typeof body.nonce).toBe('string')
    expect(body.nonce.length).toBeGreaterThan(0)
  })

  it('returns the configured oidc issuer/audience/scope/clientId when server.json has an oidc block', async () => {
    const oidc: ServerOidcConfig = {
      issuer: 'https://login.microsoftonline.com/tenant/v2.0',
      audience: 'api://studio-server',
      scope: 'Studio.Access',
      clientId: 'spa-client-id',
      rolesToScopes: {},
      defaultScopes: [],
      allowedSubjects: [],
    clientSecret: '',
    }
    health = startHealth({
      port: 0,
      routes: {
        '/auth/config': authConfigRoute({ getOidc: () => oidc, getEnvironmentId: () => 'env-456', label: 'Test Server 2', serverVersion: '0.1.0-test' }),
      },
    })
    const res = await fetch(`${baseUrl(health)}/auth/config`)
    const body = await res.json()
    expect(body.oidc).toEqual({ issuer: oidc.issuer, audience: oidc.audience, scope: oidc.scope, clientId: oidc.clientId })
  })

  it('returns a stable nonce across repeated requests within the TTL', async () => {
    health = startHealth({
      port: 0,
      routes: {
        '/auth/config': authConfigRoute({ getOidc: () => null, getEnvironmentId: () => 'env-789', label: 'Test Server 3', serverVersion: '0.1.0-test' }),
      },
    })
    const first = await (await fetch(`${baseUrl(health)}/auth/config`)).json()
    const second = await (await fetch(`${baseUrl(health)}/auth/config`)).json()
    expect(first.nonce).toBe(second.nonce)
  })

  it('still serves /healthz on the same listener', async () => {
    health = startHealth({
      port: 0,
      routes: {
        '/auth/config': authConfigRoute({ getOidc: () => null, getEnvironmentId: () => 'env-abc', label: 'Test Server 4', serverVersion: '0.1.0-test' }),
      },
    })
    const res = await fetch(`${baseUrl(health)}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
