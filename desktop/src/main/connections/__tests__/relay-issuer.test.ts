import { describe, expect, it, vi } from 'vitest'

vi.mock('../../logger', () => ({ log: vi.fn(), warn: vi.fn() }))

import { relayIssuerFor } from '../relay-issuer'
import { ownRelayIdentity } from '../own-identity'

const HOME = 'https://login.example.org/home-tenant/v2.0'
const WORK = 'https://login.example.org/work-tenant/v2.0'

function relayAnswering(body: unknown, status = 200): typeof fetch {
  return vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch
}

const twoTenants = {
  oidc: true, psk: false, issuer: HOME, audience: 'api://home-app', requiredScope: 'Relay.Access',
  issuers: [
    { issuer: HOME, audience: 'api://home-app', requiredScope: 'Relay.Access' },
    { issuer: WORK, audience: 'api://work-app', requiredScope: 'Relay.Access' },
  ],
}

describe('relayIssuerFor', () => {
  it('asks the relay over https and returns the entry for this desktop\'s own tenant', async () => {
    const fetchImpl = relayAnswering(twoTenants)
    await expect(relayIssuerFor('wss://relay.example.org/', WORK, fetchImpl)).resolves.toEqual({ issuer: WORK, audience: 'api://work-app', requiredScope: 'Relay.Access' })
    expect(vi.mocked(fetchImpl).mock.calls[0][0]).toBe('https://relay.example.org/v1/auth/config')
  })

  it('explains a relay that does not accept this tenant, is PSK-only, or cannot be reached', async () => {
    await expect(relayIssuerFor('wss://r.example', 'https://login.example.org/stranger/v2.0', relayAnswering(twoTenants))).rejects.toThrow(/does not accept sign-ins from/)
    await expect(relayIssuerFor('wss://r.example', HOME, relayAnswering({ oidc: false, psk: true }))).rejects.toThrow(/did not report an OIDC configuration/)
    await expect(relayIssuerFor('wss://r.example', HOME, relayAnswering({}, 503))).rejects.toThrow(/could not read how to sign in/)
  })
})

describe('ownRelayIdentity', () => {
  it('returns the local server\'s answer, and null when signed out or when the server cannot say', async () => {
    const identity = { issuer: HOME, subject: 'oid-home' }
    const sender = { sendAction: vi.fn(() => Promise.resolve<unknown>(identity)) }
    await expect(ownRelayIdentity(sender, 'local')).resolves.toEqual(identity)
    expect(sender.sendAction).toHaveBeenCalledWith('local', 'oidc.identity', [])

    sender.sendAction.mockResolvedValueOnce(null)
    await expect(ownRelayIdentity(sender, 'local')).resolves.toBeNull()
    sender.sendAction.mockRejectedValueOnce(new Error('unknown action'))
    await expect(ownRelayIdentity(sender, 'local')).resolves.toBeNull()
  })
})
