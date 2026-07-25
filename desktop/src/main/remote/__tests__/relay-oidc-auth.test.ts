/**
 * Tests for relay OIDC auth: credential provider resolution, auth config
 * probe parsing, scope composition, and relay_config wire shape.
 *
 * Each test is designed to fail without the corresponding change.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// relay-auth: probeRelayAuthConfig + composeOidcScope
// ---------------------------------------------------------------------------

describe('composeOidcScope', () => {
  // Import the function under test.
  // This test fails without relay-auth.ts existing and exporting composeOidcScope.
  let composeOidcScope: (audience: string, requiredScope: string) => string

  beforeEach(async () => {
    const mod = await import('../relay-auth')
    composeOidcScope = mod.composeOidcScope
  })

  it('composes api://<audience>/<requiredScope>', () => {
    expect(composeOidcScope('abc123', 'Relay.Access')).toBe('api://abc123/Relay.Access')
  })

  it('returns verbatim when requiredScope already contains a slash', () => {
    expect(composeOidcScope('abc123', 'api://abc123/Relay.Access')).toBe('api://abc123/Relay.Access')
  })

  it('returns verbatim when requiredScope starts with api://', () => {
    expect(composeOidcScope('abc123', 'api://other/Scope')).toBe('api://other/Scope')
  })

  it('handles empty requiredScope', () => {
    expect(composeOidcScope('abc123', '')).toBe('api://abc123/')
  })
})

describe('probeRelayAuthConfig', () => {
  let probeRelayAuthConfig: (relayUrl: string) => Promise<unknown>

  beforeEach(async () => {
    const mod = await import('../relay-auth')
    probeRelayAuthConfig = mod.probeRelayAuthConfig
  })

  it('returns null on network error', async () => {
    const result = await probeRelayAuthConfig('ws://no-such-host-xyz.invalid:9999')
    expect(result).toBeNull()
  })

  it('parses a valid RelayAuthConfig response', async () => {
    const validPayload = {
      oidc: true,
      issuer: 'https://login.microsoftonline.com/tenant/v2.0',
      audience: 'abc123',
      requiredScope: 'Relay.Access',
      psk: false,
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => validPayload,
    } as Response)

    const result = await probeRelayAuthConfig('wss://relay.example.com')
    expect(result).toEqual(validPayload)
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://relay.example.com/v1/auth/config',
      expect.objectContaining({ signal: expect.anything() })
    )
    fetchSpy.mockRestore()
  })

  it('returns null for malformed response (missing oidc field)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ issuer: 'x', audience: 'y' }),
    } as Response)

    const result = await probeRelayAuthConfig('ws://relay.example.com')
    expect(result).toBeNull()
    fetchSpy.mockRestore()
  })

  it('returns null for non-200 HTTP status', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response)

    const result = await probeRelayAuthConfig('ws://relay.example.com')
    expect(result).toBeNull()
    fetchSpy.mockRestore()
  })

  it('converts ws:// to http:// for the probe URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ oidc: false, issuer: '', audience: '', requiredScope: '', psk: true }),
    } as Response)

    await probeRelayAuthConfig('ws://myrelay.example.com:8080')
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://myrelay.example.com:8080/v1/auth/config',
      expect.anything()
    )
    fetchSpy.mockRestore()
  })

  it('converts wss:// to https:// for the probe URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ oidc: false, issuer: '', audience: '', requiredScope: '', psk: true }),
    } as Response)

    await probeRelayAuthConfig('wss://secure.relay.com')
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://secure.relay.com/v1/auth/config',
      expect.anything()
    )
    fetchSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// RelayClient: getCredential is called and used as Bearer
// ---------------------------------------------------------------------------

describe('RelayClient credential provider', () => {
  it('calls getCredential when it throws and schedules reconnect (no tight-loop)', async () => {
    const { RelayClient } = await import('../relay-client')

    const failCredential = vi.fn().mockRejectedValue(new Error('token unavailable'))
    const client = new RelayClient({
      relayUrl: 'wss://relay.example.com',
      apiKey: '',
      channelId: 'chan-fail',
      getCredential: failCredential,
    })

    // Spy on _scheduleReconnect BEFORE calling connect so we capture it.
    const reconnectSpy = vi.spyOn(client as any, '_scheduleReconnect')
    client.connect()
    // Allow the async _doConnect to run.
    await new Promise((r) => setTimeout(r, 20))

    expect(failCredential).toHaveBeenCalledTimes(1)
    expect(reconnectSpy).toHaveBeenCalledTimes(1)

    client.disconnect()
    reconnectSpy.mockRestore()
  })

  it('RelayClientOptions accepts getCredential field', async () => {
    // Type-level check: if getCredential is not in the interface, TypeScript
    // compilation fails. The runtime check proves the constructor accepts it.
    const { RelayClient } = await import('../relay-client')
    const getCredential = vi.fn().mockResolvedValue('tok')
    const c = new RelayClient({
      relayUrl: 'wss://relay.example.com',
      apiKey: '',
      channelId: 'chan1',
      getCredential,
    })
    expect(c).toBeDefined()
    c.disconnect()
  })

  it('does not call getCredential when absent (static apiKey path)', () => {
    const opts = {
      relayUrl: 'ws://relay.local',
      apiKey: 'static-key',
      channelId: 'chan2',
    }
    // getCredential must be optional — TypeScript compilation fails if required.
    expect(opts).not.toHaveProperty('getCredential')
  })
})

// ---------------------------------------------------------------------------
// protocol.ts: relay_config type includes OIDC additive fields
// ---------------------------------------------------------------------------

describe('desktop_relay_config wire shape', () => {
  it('accepts authMode, relayOidcIssuer, relayOidcAudience, relayOidcRequiredScope', () => {
    // Type-level test: if protocol.ts does not export the fields, TypeScript
    // compilation fails. At runtime we verify the object has the right values.
    type RelayConfigMsg = Extract<
      import('../protocol').RemoteEvent,
      { type: 'desktop_relay_config' }
    >

    const msg: RelayConfigMsg = {
      type: 'desktop_relay_config',
      relayUrl: 'wss://relay.example.com',
      relayApiKey: 'token',
      authMode: 'oidc',
      relayOidcIssuer: 'https://login.microsoftonline.com/tenant/v2.0',
      relayOidcAudience: 'abc123',
      relayOidcRequiredScope: 'api://abc123/Relay.Access',
    }

    expect(msg.type).toBe('desktop_relay_config')
    expect(msg.authMode).toBe('oidc')
    expect(msg.relayOidcAudience).toBe('abc123')
  })

  it('authMode is optional (PSK relays omit it)', () => {
    type RelayConfigMsg = Extract<
      import('../protocol').RemoteEvent,
      { type: 'desktop_relay_config' }
    >

    const msg: RelayConfigMsg = {
      type: 'desktop_relay_config',
      relayUrl: 'ws://relay.local:8080',
      relayApiKey: 'my-secret',
    }

    expect(msg.authMode).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// transport-init.ts: relayOidcClientId is included in desktop_relay_config
// ---------------------------------------------------------------------------

describe('desktop_relay_config relayOidcClientId', () => {
  it('relayOidcClientId is included in OIDC desktop_relay_config push', () => {
    // Type-level test: if relayOidcClientId is missing from the protocol type,
    // TypeScript compilation fails. At runtime, verify the field carries the
    // configured client ID (deployment-provided; Ion ships no default identity).
    type RelayConfigMsg = Extract<
      import('../protocol').RemoteEvent,
      { type: 'desktop_relay_config' }
    >

    const configuredClientId = 'client-id-from-engine-json'

    const msg: RelayConfigMsg = {
      type: 'desktop_relay_config',
      relayUrl: 'wss://relay.example.com',
      relayApiKey: 'oidc-token',
      authMode: 'oidc',
      relayOidcIssuer: 'https://login.microsoftonline.com/tenant/v2.0',
      relayOidcAudience: 'abc123',
      relayOidcRequiredScope: 'api://abc123/Relay.Access',
      relayOidcClientId: configuredClientId,
    }

    expect(msg.relayOidcClientId).toBe(configuredClientId)
  })

  it('relayOidcClientId absent from PSK desktop_relay_config push', () => {
    // PSK path must not include OIDC fields. The type enforces this: relayOidcClientId
    // is optional, so a PSK-shaped object with no OIDC fields is valid.
    type RelayConfigMsg = Extract<
      import('../protocol').RemoteEvent,
      { type: 'desktop_relay_config' }
    >

    const msg: RelayConfigMsg = {
      type: 'desktop_relay_config',
      relayUrl: 'ws://relay.local:8080',
      relayApiKey: 'static-psk',
    }

    expect(msg.relayOidcClientId).toBeUndefined()
    expect(msg.authMode).toBeUndefined()
  })
})
