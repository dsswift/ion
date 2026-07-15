/**
 * entra-auth.test.ts — Unit tests for the engine-backed Entra OIDC surface.
 *
 * The engine owns the OIDC identity (login flow, grant persistence, silent
 * refresh, per-scope minting); the desktop orchestrates the interactive
 * browser step and consumes identity/token state over the wire. These
 * tests pin the desktop side of that contract against a mocked engine
 * bridge.
 *
 * Coverage:
 *   E1-a  getAccessToken returns the engine-minted token (oidc_token).
 *   E1-b  getAccessToken returns null on engine error / missing token.
 *   E1-c  getSignedInIdentity maps the oidc_identity snapshot.
 *   E1-d  getSignedInIdentity returns null when signed out.
 *   E1-e  identity user claim falls back to subject when username absent.
 *   E2-a  signIn opens the engine's authorization URL and resolves once
 *         the engine reports signed-in.
 *   E2-b  signIn throws when the engine has no identity provider.
 *   E2-c  signOut sends oidc_logout and throws on engine failure.
 *   F4-a..d  egress user-attribution stamping (unchanged behavior).
 *   M-a   shipToEgress honors shipOwnRecords=false (matrix gate) while
 *         shipTailedToEgress bypasses it.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

// Isolate HOME to a per-file temp dir BEFORE the egress modules are
// imported, so the spool path (derived from homedir() at import time)
// points at a throwaway location instead of the user's REAL
// ~/.ion/.egress-spool.jsonl (whose drained records would pollute the
// fetch-spy assertions below). Mirrors log-egress-drain.test.ts.
vi.hoisted(() => {
  const os = require('os') as typeof import('os')
  const fs = require('fs') as typeof import('fs')
  const p = require('path') as typeof import('path')
  const home = fs.mkdtempSync(p.join(os.tmpdir(), 'ion-egress-home-entra-'))
  fs.mkdirSync(p.join(home, '.ion'), { recursive: true })
  process.env.HOME = home
})

// ---------------------------------------------------------------------------
// Hoisted mock state — must be defined before vi.mock() factories run
// ---------------------------------------------------------------------------

const bridgeState = vi.hoisted(() => ({
  // Responses keyed by cmd. Each request pops the next response for its
  // cmd, reusing the last one when only one remains.
  responses: new Map<string, Array<{ ok: boolean; error?: string; data?: unknown }>>(),
  calls: [] as Array<{ cmd: string; payload: Record<string, unknown> }>,
  openedUrls: [] as string[],
}))

function queueResponse(cmd: string, resp: { ok: boolean; error?: string; data?: unknown }): void {
  const list = bridgeState.responses.get(cmd) ?? []
  list.push(resp)
  bridgeState.responses.set(cmd, list)
}

vi.mock('electron', () => ({
  app: { isPackaged: false },
  shell: {
    openExternal: vi.fn(async (url: string) => {
      bridgeState.openedUrls.push(url)
    }),
  },
}))

vi.mock('../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../state', () => ({
  engineBridge: {
    request: vi.fn(async (cmd: string, payload: Record<string, unknown> = {}) => {
      bridgeState.calls.push({ cmd, payload })
      const list = bridgeState.responses.get(cmd)
      if (!list || list.length === 0) {
        return { ok: false, error: `no mocked response for ${cmd}` }
      }
      return list.length === 1 ? list[0] : list.shift()!
    }),
  },
}))

// ---------------------------------------------------------------------------
// Import after mocks are established
// ---------------------------------------------------------------------------

import { getAccessToken, getSignedInIdentity, signIn, signOut } from '../oauth/entra-auth'
import {
  setEgressUser,
  getEgressUser,
  shipToEgress,
  shipTailedToEgress,
  configureEgress,
  closeEgress,
  _resetEgressForTest,
  type EgressRecord,
} from '../log-egress'

const SAMPLE_RECORD: EgressRecord = {
  ts: '2026-07-07T12:00:00.000000000Z',
  level: 'INFO',
  msg: 'test',
  component: 'desktop',
}

beforeEach(() => {
  bridgeState.responses.clear()
  bridgeState.calls.length = 0
  bridgeState.openedUrls.length = 0
})

// ---------------------------------------------------------------------------
// Tests: getAccessToken (engine-minted, oidc_token)
// ---------------------------------------------------------------------------

describe('getAccessToken', () => {
  it('E1-a: returns the engine-minted token', async () => {
    queueResponse('oidc_token', { ok: true, data: { accessToken: 'engine-minted-at' } })
    const token = await getAccessToken()
    expect(token).toBe('engine-minted-at')
    expect(bridgeState.calls[0].cmd).toBe('oidc_token')
  })

  it('E1-b: returns null on engine error or missing token', async () => {
    queueResponse('oidc_token', { ok: false, error: 'no signed-in operator' })
    expect(await getAccessToken()).toBeNull()

    bridgeState.responses.clear()
    queueResponse('oidc_token', { ok: true, data: {} })
    expect(await getAccessToken()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tests: getSignedInIdentity (oidc_identity snapshot)
// ---------------------------------------------------------------------------

describe('getSignedInIdentity', () => {
  it('E1-c: maps the oidc_identity snapshot', async () => {
    queueResponse('oidc_identity', {
      ok: true,
      data: { signedIn: true, subject: 'oid-1234', username: 'alice@corp.example.com', name: 'Alice', provider: 'entra' },
    })
    const identity = await getSignedInIdentity()
    expect(identity).not.toBeNull()
    expect(identity!.user).toBe('alice@corp.example.com')
    expect(identity!.oid).toBe('oid-1234')
    expect(identity!.displayName).toBe('Alice')
  })

  it('E1-d: returns null when signed out', async () => {
    queueResponse('oidc_identity', { ok: true, data: { signedIn: false } })
    expect(await getSignedInIdentity()).toBeNull()
  })

  it('E1-e: falls back to subject when username is absent', async () => {
    queueResponse('oidc_identity', {
      ok: true,
      data: { signedIn: true, subject: 'oid-fallback-5678', name: 'Service Account' },
    })
    const identity = await getSignedInIdentity()
    expect(identity!.user).toBe('oid-fallback-5678')
  })
})

// ---------------------------------------------------------------------------
// Tests: signIn / signOut (engine-orchestrated)
// ---------------------------------------------------------------------------

describe('signIn', () => {
  it('E2-a: opens the engine authorization URL and resolves on signed-in', async () => {
    queueResponse('oidc_begin_login', {
      ok: true,
      data: { authorizationUrl: 'https://login.microsoftonline.com/x/authorize?state=s' },
    })
    queueResponse('oidc_identity', {
      ok: true,
      data: { signedIn: true, subject: 'oid-1', username: 'josh@corp.example.com' },
    })

    const identity = await signIn()
    expect(bridgeState.openedUrls).toEqual(['https://login.microsoftonline.com/x/authorize?state=s'])
    expect(identity.user).toBe('josh@corp.example.com')
  }, 15_000)

  it('E2-b: throws when the engine has no identity provider configured', async () => {
    queueResponse('oidc_begin_login', { ok: false, error: 'no OIDC identity provider configured' })
    await expect(signIn()).rejects.toThrow(/no OIDC identity provider/)
    expect(bridgeState.openedUrls).toHaveLength(0)
  })
})

describe('signOut', () => {
  it('E2-c: sends oidc_logout and throws on engine failure', async () => {
    queueResponse('oidc_logout', { ok: true })
    await signOut()
    expect(bridgeState.calls.some((c) => c.cmd === 'oidc_logout')).toBe(true)

    bridgeState.responses.clear()
    bridgeState.calls.length = 0
    queueResponse('oidc_logout', { ok: false, error: 'boom' })
    await expect(signOut()).rejects.toThrow('boom')
  })
})

// ---------------------------------------------------------------------------
// Tests: egress user-attribution (F4) + shipping-matrix gates
// ---------------------------------------------------------------------------

describe('egress user-attribution (F4) and matrix gates', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    _resetEgressForTest()
    fetchSpy = vi.fn().mockResolvedValue({ status: 200, ok: true })
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    _resetEgressForTest()
    vi.unstubAllGlobals()
  })

  function shippedRecords(): EgressRecord[] {
    const all: EgressRecord[] = []
    for (const [, init] of fetchSpy.mock.calls) {
      all.push(...(JSON.parse((init as { body: string }).body) as EgressRecord[]))
    }
    return all
  }

  it('F4-c: setEgressUser / getEgressUser round-trip', () => {
    setEgressUser('user@example.com')
    expect(getEgressUser()).toBe('user@example.com')
    setEgressUser(undefined)
    expect(getEgressUser()).toBeUndefined()
  })

  it('F4-a: stamps user field when egressUser is set and record has no user', async () => {
    setEgressUser('alice@corp.example.com')
    configureEgress({
      egressTargets: ['http'],
      egressEndpoint: 'https://sink.example.com/logs',
      egressFlushIntervalMs: 100_000,
    })

    shipToEgress({ ...SAMPLE_RECORD })
    await closeEgress()

    const body = shippedRecords()
    expect(body).toHaveLength(1)
    expect(body[0].user).toBe('alice@corp.example.com')
  })

  it('F4-b: omits user field when egressUser is not set', async () => {
    setEgressUser(undefined)
    configureEgress({
      egressTargets: ['http'],
      egressEndpoint: 'https://sink.example.com/logs',
      egressFlushIntervalMs: 100_000,
    })

    shipToEgress({ ...SAMPLE_RECORD })
    await closeEgress()

    const body = shippedRecords()
    expect(body).toHaveLength(1)
    expect(body[0].user).toBeUndefined()
  })

  it('F4-d: preserves existing user field if record already has one', async () => {
    setEgressUser('default@corp.example.com')
    configureEgress({
      egressTargets: ['http'],
      egressEndpoint: 'https://sink.example.com/logs',
      egressFlushIntervalMs: 100_000,
    })

    shipToEgress({ ...SAMPLE_RECORD, user: 'engine-user@example.com' })
    await closeEgress()

    const body = shippedRecords()
    expect(body[0].user).toBe('engine-user@example.com')
  })

  it('M-a: shipToEgress gated by shipOwnRecords=false; shipTailedToEgress bypasses', async () => {
    configureEgress(
      {
        egressTargets: ['http'],
        egressEndpoint: 'https://sink.example.com/logs',
        egressFlushIntervalMs: 100_000,
      },
      undefined,
      { shipOwnRecords: false },
    )

    shipToEgress({ ...SAMPLE_RECORD, msg: 'own-record-must-not-ship' })
    shipTailedToEgress({ ...SAMPLE_RECORD, msg: 'tailed-record', component: 'engine' })
    await closeEgress()

    const body = shippedRecords()
    expect(body).toHaveLength(1)
    expect(body[0].msg).toBe('tailed-record')
  })
})
