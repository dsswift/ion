import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../engine/engine-bridge-fs', () => ({
  getEngineHostInfo: vi.fn(() => Promise.resolve({ ok: true, data: { version: '1.2.3' } })),
  getEnterprisePolicy: vi.fn(() => Promise.resolve(null)),
}))

vi.mock('../../state', () => ({
  engineBridge: { connected: true },
  deviceFocusMap: new Map(),
  state: { remoteTransport: null },
}))

// "Nobody signed in" by default; one test below signs someone in to pin that
// a local connection's subject does not follow the sign-in.
vi.mock('../../oauth/entra-flow', () => ({ getSignedInIdentityIfEngineConnected: vi.fn().mockResolvedValue(null) }))

import { startHarness, connectTcp, connectLocal, waitOpen, sendFrame, nextFrame, helloFrame, closeSocket, resetConnectionRegistryForTest, type Harness } from './harness'
import { getSignedInIdentityIfEngineConnected } from '../../oauth/entra-flow'
import { PROTOCOL_VERSION } from '@ion/shared/studio-wire/version'
import { SCOPES } from '@ion/shared/studio-wire/types'
import type { AuthPolicy } from '../hello'
import { lookupPrincipal, lookupClaims, _resetPrincipalRegistryForTest } from '../../identity/principal-registry'
import { getEnterprisePolicy } from '../../engine/engine-bridge-fs'
import { publishEnterprisePolicy } from '../../enterprise-policy-publish'
import type { EnterprisePolicy, SessionPrincipal } from '@ion/shared/types-engine'

let harness: Harness
let dataDir: string
let originalIonDataDir: string | undefined

beforeEach(async () => {
  originalIonDataDir = process.env.ION_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'ion-studio-wire-hello-data-'))
  process.env.ION_DATA_DIR = dataDir
  harness = await startHarness()
})

afterEach(async () => {
  await harness.close()
  resetConnectionRegistryForTest()
  _resetPrincipalRegistryForTest()
  vi.mocked(getSignedInIdentityIfEngineConnected).mockReset().mockResolvedValue(null)
  if (originalIonDataDir === undefined) delete process.env.ION_DATA_DIR
  else process.env.ION_DATA_DIR = originalIonDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

describe('studio_hello: protocol version window', () => {
  it('accepts the current PROTOCOL_VERSION on the local transport', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ protocolVersion: PROTOCOL_VERSION }))
    const frame = await nextFrame(ws)
    expect(frame.type).toBe('studio_welcome')
    await closeSocket(ws)
  })

  it('accepts PROTOCOL_VERSION - 1 (the one-version-behind window)', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ protocolVersion: PROTOCOL_VERSION - 1 }))
    const frame = await nextFrame(ws)
    expect(frame.type).toBe('studio_welcome')
    await closeSocket(ws)
  })

  it('refuses a far-future protocolVersion with requiredProtocolVersion set', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ protocolVersion: PROTOCOL_VERSION + 99 }))
    const frame = await nextFrame(ws)
    expect(frame).toMatchObject({ type: 'studio_refused', reason: 'protocol_version', requiredProtocolVersion: PROTOCOL_VERSION })
    await closeSocket(ws)
  })

  it('refuses protocolVersion PROTOCOL_VERSION + 1 with requiredProtocolVersion set', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ protocolVersion: PROTOCOL_VERSION + 1 }))
    const frame = await nextFrame(ws)
    expect(frame).toMatchObject({ type: 'studio_refused', reason: 'protocol_version', requiredProtocolVersion: PROTOCOL_VERSION })
    await closeSocket(ws)
  })
})

describe('studio_hello: local credential transport binding', () => {
  it('accepts {kind:"local"} on the local transport', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    const frame = await (async () => {
      sendFrame(ws, helloFrame({ credential: { kind: 'local' } }))
      return nextFrame(ws)
    })()
    expect(frame.type).toBe('studio_welcome')
    if (frame.type === 'studio_welcome') {
      expect(frame.principal.subject).toMatch(/^local:/)
      expect(frame.scopes).toContain('admin')
      // Task 10: the local desktop with no enterprise config sees every
      // settings group -- computeSettingsHiddenGroups's other branches are
      // unit-tested directly in settings-visibility.test.ts.
      expect(frame.settingsHiddenGroups).toEqual([])
      expect(frame.onHost).toBe(true)
    }
    await closeSocket(ws)
  })

  it('keeps the OS account as the subject on {kind:"local"} while the engine is signed in', async () => {
    vi.mocked(getSignedInIdentityIfEngineConnected).mockResolvedValue({
      user: 'JDoe@example.com',
      username: 'JDoe@example.com',
      displayName: '',
      oid: 'entra-oid-123',
      issuer: 'https://login.microsoftonline.com/tenant/v2.0',
    })
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ credential: { kind: 'local' } }))
    const frame = await nextFrame(ws)
    expect(frame.type).toBe('studio_welcome')
    if (frame.type === 'studio_welcome') {
      expect(frame.principal.subject).toMatch(/^local:/)
      expect(frame.principal).toMatchObject({ provider: 'os', kind: 'local' })
    }
    await closeSocket(ws)
  })

  it('refuses {kind:"local"} on the TCP transport as unauthorized', async () => {
    const ws = connectTcp(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ credential: { kind: 'local' } }))
    const frame = await nextFrame(ws)
    expect(frame).toEqual({ type: 'studio_refused', reason: 'unauthorized' })
    await closeSocket(ws)
  })
})

describe('studio_hello: unimplemented credential kinds', () => {
  it('refuses a bearer credential on the local transport as unauthorized', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ credential: { kind: 'bearer', token: 'opaque' } }))
    const frame = await nextFrame(ws)
    expect(frame).toEqual({ type: 'studio_refused', reason: 'unauthorized' })
    await closeSocket(ws)
  })

  it('refuses a paired credential on the TCP transport as unauthorized', async () => {
    const ws = connectTcp(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ credential: { kind: 'paired', clientId: 'peer-1', proof: 'sig' } }))
    const frame = await nextFrame(ws)
    // An unsealed paired hello is refused before the credential is even
    // looked at (`sealed-tcp.test.ts` covers the sealed path).
    expect(frame).toMatchObject({ type: 'studio_refused', reason: 'unauthorized' })
    await closeSocket(ws)
  })
})

describe('studio_hello: reconnect displaces the same client', () => {
  it('welcomes a reconnect with the same clientId and closes the previous connection as displaced', async () => {
    const clientId = 'dup-client-1'
    const first = connectLocal(harness)
    await waitOpen(first)
    sendFrame(first, helloFrame({ clientId }))
    expect((await nextFrame(first)).type).toBe('studio_welcome')

    // Start listening on the first socket BEFORE the reconnect: studio_close
    // is sent and the socket torn down in the same tick, so a listener
    // attached afterwards would miss the frame and see only the close.
    const displaced = nextFrame(first)

    // Same clientId, same subject (both resolve to the local principal): the
    // reconnect must win. Refusing here is what left a client locked out of
    // its own identity whenever a socket died without a close frame.
    const second = connectLocal(harness)
    await waitOpen(second)
    sendFrame(second, helloFrame({ clientId }))
    expect((await nextFrame(second)).type).toBe('studio_welcome')

    // The displaced connection is told why rather than left to guess.
    expect(await displaced).toMatchObject({ type: 'studio_close', reason: 'displaced' })

    await closeSocket(first)
    await closeSocket(second)
  })

  it('still refuses a clientId already connected for a DIFFERENT subject', async () => {
    // An unauthenticated or unrelated caller must never evict a live client by
    // guessing its clientId, so displacement is gated on subject identity.
    const twoSubjects: AuthPolicy = {
      authenticate: (credential) =>
        Promise.resolve(
          credential.kind === 'bearer'
            ? { ok: true as const, principal: { subject: `subject-for-${credential.token}`, displayName: credential.token }, scopes: [...SCOPES] }
            : { ok: false as const },
        ),
    }
    const h = await startHarness({ authPolicy: twoSubjects })
    try {
      const clientId = 'shared-client-id'
      const a = connectTcp(h)
      await waitOpen(a)
      sendFrame(a, helloFrame({ clientId, credential: { kind: 'bearer', token: 'alice' } }))
      expect((await nextFrame(a)).type).toBe('studio_welcome')

      const b = connectTcp(h)
      await waitOpen(b)
      sendFrame(b, helloFrame({ clientId, credential: { kind: 'bearer', token: 'mallory' } }))
      expect(await nextFrame(b)).toMatchObject({ type: 'studio_refused', reason: 'duplicate_client' })

      await closeSocket(a)
      await closeSocket(b)
    } finally {
      await h.close()
    }
  })
})

describe('studio_hello: P0 principal registration', () => {
  it('registers the local principal in the registry on a successful local hello', async () => {
    const ws = connectLocal(harness)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ protocolVersion: PROTOCOL_VERSION }))
    const frame = await nextFrame(ws)
    expect(frame.type).toBe('studio_welcome')
    const subject = (frame as { principal: { subject: string } }).principal.subject
    expect(lookupPrincipal(subject)).toEqual((frame as { principal: unknown }).principal)
    await closeSocket(ws)
  })

  it('registers a bearer principal and its claims (never echoed back on the wire)', async () => {
    const bearerPolicy: AuthPolicy = {
      authenticate: () =>
        Promise.resolve({
          ok: true as const,
          principal: { subject: 'alice', displayName: 'Alice', provider: 'entra', kind: 'operator' },
          scopes: [...SCOPES],
          claims: { roles: ['admin'] },
        }),
    }
    const h = await startHarness({ authPolicy: bearerPolicy })
    try {
      const ws = connectTcp(h)
      await waitOpen(ws)
      sendFrame(ws, helloFrame({ credential: { kind: 'bearer', token: 'anything' } }))
      const frame = await nextFrame(ws)
      expect(frame.type).toBe('studio_welcome')
      // The claims never ride the wire -- only the registry (server-side only) has them.
      expect(JSON.stringify(frame)).not.toContain('roles')
      // Off the local socket, whatever the scopes: not on the server's host.
      expect((frame as { onHost?: boolean }).onHost).toBe(false)
      expect(lookupPrincipal('alice')).toEqual({ subject: 'alice', displayName: 'Alice', provider: 'entra', kind: 'operator' })
      expect(lookupClaims('alice')).toEqual({ roles: ['admin'] })
      await closeSocket(ws)
    } finally {
      await h.close()
    }
  })
})

describe('studio_welcome: enterprise policy per principal', () => {
  const processPolicy: EnterprisePolicy = { allowedModels: ['model-a', 'model-b'] }
  const tokenPolicy: AuthPolicy = {
    authenticate: (credential) =>
      Promise.resolve({
        ok: true as const,
        principal: { subject: credential.kind === 'bearer' ? credential.token : 'nobody', displayName: 'A user', provider: 'entra', kind: 'operator' },
        scopes: [...SCOPES],
        claims: { groups: ['contractors'] },
      }),
  }

  afterEach(() => {
    publishEnterprisePolicy(null)
    vi.mocked(getEnterprisePolicy).mockReset().mockResolvedValue(null)
  })

  async function welcomePolicy(h: Harness, token: string): Promise<unknown> {
    const ws = connectTcp(h)
    await waitOpen(ws)
    sendFrame(ws, helloFrame({ credential: { kind: 'bearer', token } }))
    const frame = await nextFrame(ws)
    expect(frame.type).toBe('studio_welcome')
    await closeSocket(ws)
    return (frame as { enterprisePolicy: unknown }).enterprisePolicy
  }

  it('welcomes each principal with the policy the engine resolves for that principal', async () => {
    publishEnterprisePolicy(processPolicy)
    vi.mocked(getEnterprisePolicy).mockImplementation((principal?: SessionPrincipal) =>
      Promise.resolve(principal?.subject === 'contractor' ? { allowedModels: ['model-a'], assetScopes: ['contractors'] } : processPolicy),
    )
    const h = await startHarness({ authPolicy: tokenPolicy })
    try {
      const [contractor, staff] = await Promise.all([welcomePolicy(h, 'contractor'), welcomePolicy(h, 'staff')])
      expect(contractor).toEqual({ allowedModels: ['model-a'], assetScopes: ['contractors'] })
      expect(staff).toEqual(processPolicy)
      // The engine was asked with the verified principal and its claims.
      expect(vi.mocked(getEnterprisePolicy).mock.calls.map(([p]) => [p?.subject, p?.claims])).toEqual(
        expect.arrayContaining([
          ['contractor', { groups: ['contractors'] }],
          ['staff', { groups: ['contractors'] }],
        ]),
      )
    } finally {
      await h.close()
    }
  })

  it('falls back to the process policy when the engine cannot resolve one for the principal', async () => {
    publishEnterprisePolicy(processPolicy)
    vi.mocked(getEnterprisePolicy).mockRejectedValue(new Error('engine unreachable'))
    const h = await startHarness({ authPolicy: tokenPolicy })
    try {
      expect(await welcomePolicy(h, 'contractor')).toEqual(processPolicy)
    } finally {
      await h.close()
    }
  })

  it('asks the engine for nothing when there is no enterprise policy at all', async () => {
    const h = await startHarness({ authPolicy: tokenPolicy })
    try {
      expect(await welcomePolicy(h, 'contractor')).toBeNull()
      expect(getEnterprisePolicy).not.toHaveBeenCalled()
    } finally {
      await h.close()
    }
  })
})
