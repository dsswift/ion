/**
 * Regression tests for the relay_config push path.
 *
 * The live failure these pin: the desktop resolved OIDC for its own relay
 * transport, but the iOS push independently re-read `settings.json`. A renderer
 * settings save had wiped `relayAuthMode` from disk, so the push fell through
 * to the PSK branch and sent `{ relayUrl, relayApiKey: '' }` — the stored PSK
 * is deliberately empty in OIDC mode. iOS's `handleRelayConfig` persists the
 * incoming values onto the paired-device record, so the empty push destroyed
 * the phone's relay pairing and it could no longer reconnect.
 *
 * Two rules are pinned here:
 *   1. The resolved (in-memory) auth mode wins over stale/absent disk state.
 *   2. A config with no usable credential is NEVER sent.
 *
 * Both fail on the unfixed code path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const settingsMock = vi.hoisted(() => ({ onDisk: {} as Record<string, unknown> }))
const transportMock = vi.hoisted(() => ({ sent: [] as unknown[] }))
const bridgeMock = vi.hoisted(() => ({
  response: { ok: true, data: { accessToken: 'fresh-token', expiresAt: 1_800_000 } } as {
    ok: boolean
    data?: { accessToken?: string; expiresAt?: number }
    error?: string
  },
  throws: false,
}))

vi.mock('../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../../settings-store', () => ({
  readSettings: () => ({ ...settingsMock.onDisk }),
}))

vi.mock('../../state', () => ({
  state: {
    get remoteTransport() {
      return {
        send: (msg: unknown) => { transportMock.sent.push(msg) },
      }
    },
  },
  engineBridge: {
    request: async () => {
      if (bridgeMock.throws) throw new Error('bridge exploded')
      return bridgeMock.response
    },
  },
}))

vi.mock('../../oauth/entra-auth', () => ({
  getConfiguredOidcClientId: () => 'configured-client-id',
}))

import {
  sendRelayConfigToPeers,
  setResolvedRelayAuth,
  clearResolvedRelayAuth,
  resolveRelayAuthMode,
} from '../relay-config-push'

type RelayConfigMsg = {
  type: string
  relayUrl: string
  relayApiKey: string
  authMode?: string
  relayOidcIssuer?: string
  relayOidcAudience?: string
  relayOidcRequiredScope?: string
  relayOidcClientId?: string
}

describe('relay_config push', () => {
  beforeEach(() => {
    transportMock.sent = []
    settingsMock.onDisk = {}
    bridgeMock.throws = false
    bridgeMock.response = { ok: true, data: { accessToken: 'fresh-token', expiresAt: 1_800_000 } }
    clearResolvedRelayAuth()
  })

  // ─── Rule 1: resolved auth mode beats stale disk ───

  it('sends an OIDC config when the mode is resolved in memory but absent from disk', async () => {
    // Exactly the production shape: the probe resolved OIDC and upgraded the
    // transport, then a renderer save erased the OIDC keys from settings.json.
    settingsMock.onDisk = { relayUrl: 'wss://relay.example.com', relayApiKey: '' }
    setResolvedRelayAuth({
      mode: 'oidc',
      issuer: 'https://issuer.example.com/v2.0',
      audience: 'api://audience-id',
      scope: 'api://audience-id/Relay.Access',
    })

    const result = await sendRelayConfigToPeers('test')

    expect(result.sent).toBe(true)
    expect(transportMock.sent).toHaveLength(1)
    const msg = transportMock.sent[0] as RelayConfigMsg
    expect(msg.type).toBe('desktop_relay_config')
    expect(msg.authMode).toBe('oidc')
    expect(msg.relayApiKey).toBe('fresh-token')
    expect(msg.relayOidcIssuer).toBe('https://issuer.example.com/v2.0')
    expect(msg.relayOidcRequiredScope).toBe('api://audience-id/Relay.Access')
    expect(msg.relayOidcClientId).toBe('configured-client-id')
  })

  it('returns the minted token expiry so the caller can schedule a refresh', async () => {
    settingsMock.onDisk = { relayUrl: 'wss://relay.example.com' }
    setResolvedRelayAuth({
      mode: 'oidc',
      issuer: 'https://issuer.example.com/v2.0',
      audience: 'api://audience-id',
      scope: 'api://audience-id/Relay.Access',
    })

    const result = await sendRelayConfigToPeers('test')

    expect(result.expiresAt).toBe(1_800_000)
    // The scope rides back with the expiry so the caller arms the refresh
    // against the SAME scope this push minted with. Reading it back out of
    // resolved-auth state let the two diverge, and a refresh armed with an
    // empty scope fails at mint time and silently ends the chain — there is no
    // re-schedule on that path.
    expect(result.scope).toBe('api://audience-id/Relay.Access')
  })

  it('omits the scope in PSK mode, so no refresh is armed', async () => {
    settingsMock.onDisk = { relayUrl: 'wss://relay.example.com', relayApiKey: 'stored-psk' }

    const result = await sendRelayConfigToPeers('test')

    expect(result.sent).toBe(true)
    expect(result.scope).toBeUndefined()
    expect(result.expiresAt).toBeUndefined()
  })

  it('falls back to the stored OIDC config when nothing is resolved in memory', async () => {
    settingsMock.onDisk = {
      relayUrl: 'wss://relay.example.com',
      relayAuthMode: 'oidc',
      relayOidcIssuer: 'https://disk-issuer.example.com/v2.0',
      relayOidcAudience: 'api://disk-audience',
      relayOidcRequiredScope: 'Relay.Access',
    }

    const result = await sendRelayConfigToPeers('test')

    expect(result.sent).toBe(true)
    const msg = transportMock.sent[0] as RelayConfigMsg
    expect(msg.authMode).toBe('oidc')
    expect(msg.relayOidcIssuer).toBe('https://disk-issuer.example.com/v2.0')
    // The bare stored scope is composed before it reaches the wire — iOS
    // passes it verbatim to Entra and a bare "Relay.Access" resolves against
    // Microsoft Graph instead of the relay.
    expect(msg.relayOidcRequiredScope).toBe('api://disk-audience/Relay.Access')
  })

  // ─── Rule 2: never push a credential-less config ───

  it('suppresses the push when the PSK is empty', async () => {
    // The exact wire event that broke the phone: relay URL present, no auth
    // mode anywhere, empty stored key.
    settingsMock.onDisk = { relayUrl: 'wss://relay.example.com', relayApiKey: '' }

    const result = await sendRelayConfigToPeers('test')

    expect(result.sent).toBe(false)
    expect(transportMock.sent).toHaveLength(0)
  })

  it('suppresses the push when the OIDC token mint fails', async () => {
    settingsMock.onDisk = { relayUrl: 'wss://relay.example.com' }
    setResolvedRelayAuth({
      mode: 'oidc',
      issuer: 'https://issuer.example.com/v2.0',
      audience: 'api://audience-id',
      scope: 'api://audience-id/Relay.Access',
    })
    bridgeMock.response = { ok: false, error: 'no interactive session' }

    const result = await sendRelayConfigToPeers('test')

    expect(result.sent).toBe(false)
    expect(transportMock.sent).toHaveLength(0)
  })

  it('suppresses the push when the OIDC token mint throws', async () => {
    settingsMock.onDisk = { relayUrl: 'wss://relay.example.com' }
    setResolvedRelayAuth({
      mode: 'oidc',
      issuer: 'https://issuer.example.com/v2.0',
      audience: 'api://audience-id',
      scope: 'api://audience-id/Relay.Access',
    })
    bridgeMock.throws = true

    const result = await sendRelayConfigToPeers('test')

    expect(result.sent).toBe(false)
    expect(transportMock.sent).toHaveLength(0)
  })

  it('sends a PSK config when a real stored key exists', async () => {
    settingsMock.onDisk = { relayUrl: 'wss://relay.example.com', relayApiKey: 'real-psk' }

    const result = await sendRelayConfigToPeers('test')

    expect(result.sent).toBe(true)
    const msg = transportMock.sent[0] as RelayConfigMsg
    expect(msg.relayApiKey).toBe('real-psk')
    expect(msg.authMode).toBeUndefined()
  })

  it('skips the push when no relay URL is configured', async () => {
    settingsMock.onDisk = { relayApiKey: 'real-psk' }

    const result = await sendRelayConfigToPeers('test')

    expect(result.sent).toBe(false)
    expect(transportMock.sent).toHaveLength(0)
  })

  // ─── Resolution state lifecycle ───

  it('clearResolvedRelayAuth drops back to the stored mode', async () => {
    setResolvedRelayAuth({
      mode: 'oidc',
      issuer: 'https://issuer.example.com/v2.0',
      audience: 'api://audience-id',
      scope: 'api://audience-id/Relay.Access',
    })
    expect(resolveRelayAuthMode({})).not.toBeNull()

    clearResolvedRelayAuth()

    // A transport teardown must not leave a stale OIDC resolution behind for a
    // subsequent PSK-mode init to inherit.
    expect(resolveRelayAuthMode({})).toBeNull()
  })
})
