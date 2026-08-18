/**
 * transport-lan-auth-secret.test.ts
 *
 * Regression coverage for the corrupt-pairing-secret path in LAN auth.
 *
 * Production failure this pins: the desktop's stored `sharedSecret` for a
 * known device decrypted to ciphertext (its safeStorage Keychain grant was
 * lost across a reinstall). `Buffer.from(ciphertext, 'base64')` does not
 * throw, so the wrong key flowed straight into HMAC verification and the
 * device was refused as "invalid proof" — indistinguishable from an attacker.
 * Each refusal then charged the phone's IP an exponential auth-failure
 * backoff, so the desktop rate-limited the phone over the desktop's own
 * corrupt record, and the cooldown obstructed the re-pair that would fix it.
 *
 * The three properties asserted here:
 *   1. A device with an unusable stored secret is refused (never authenticated
 *      with a wrong key).
 *   2. It is refused with close code 4004, distinct from 4003 "unknown
 *      device", so iOS can route to an automatic repair instead of the
 *      pairing screen.
 *   3. The refusal charges NO IP penalty — the fault is on the desktop side.
 *      A well-formed secret that fails HMAC still does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomBytes } from 'crypto'

vi.mock('../../logger', () => ({
  log: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

// verifyAuthProof is controlled per-test: the secret-unusable path must be
// taken BEFORE proof verification is ever reached.
const mockVerifyAuthProof = vi.fn(() => true)
vi.mock('../crypto', () => ({
  createAuthNonce: () => 'test-nonce',
  verifyAuthProof: (...args: unknown[]) => mockVerifyAuthProof(...(args as [])),
}))

import { handleLanAuthResponse, type LanAuthCtx } from '../transport-lan-auth'
import { LAN_CLOSE_SECRET_UNUSABLE, LAN_CLOSE_UNKNOWN_DEVICE } from '../protocol'
import type { PairedDevice } from '../protocol'

const GOOD_SECRET = randomBytes(32).toString('base64')
const CORRUPT_SECRET = 'enc:v1:' + randomBytes(48).toString('base64')

interface Harness {
  ctx: LanAuthCtx
  authFailures: string[]
  authSuccesses: string[]
  disconnects: Array<{ connectionId: string; code: number; reason: string }>
  sentRaw: Array<{ payload: string; connectionId: string }>
  authenticated: string[]
}

function makeHarness(device: PairedDevice | null): Harness {
  const authFailures: string[] = []
  const authSuccesses: string[] = []
  const disconnects: Array<{ connectionId: string; code: number; reason: string }> = []
  const sentRaw: Array<{ payload: string; connectionId: string }> = []
  const authenticated: string[] = []

  const lan = {
    sendRaw: (payload: string, connectionId: string) => { sentRaw.push({ payload, connectionId }) },
    getClientIp: () => '::ffff:192.168.86.181',
    recordAuthFailure: (ip: string) => { authFailures.push(ip) },
    recordAuthSuccess: (ip: string) => { authSuccesses.push(ip) },
    disconnectClient: (connectionId: string, code: number, reason: string) => {
      disconnects.push({ connectionId, code, reason })
    },
    rekeyClient: () => {},
  }

  const ctx: LanAuthCtx = {
    lan: lan as unknown as LanAuthCtx['lan'],
    lanAuthPending: new Map([['lan-1', { nonce: 'test-nonce', timeout: setTimeout(() => {}, 0) }]]),
    lanDeviceMap: new Map(),
    deviceSecrets: new Map(),
    syncWorkerSecrets: () => {},
    getPairedDevice: () => device,
    recomputeState: () => {},
    emit: () => {},
    onAuthenticated: (deviceId: string) => { authenticated.push(deviceId) },
  }

  return { ctx, authFailures, authSuccesses, disconnects, sentRaw, authenticated }
}

function authResponse(deviceId = 'dev-1'): { type: string; payload: string } {
  return {
    type: 'auth_response',
    payload: JSON.stringify({ type: 'auth_response', deviceId, proof: 'proof-b64' }),
  }
}

function pairedDevice(sharedSecret: string): PairedDevice {
  return {
    id: 'dev-1',
    name: 'iPhone',
    pairedAt: new Date().toISOString(),
    lastSeen: null,
    channelId: 'chan-1',
    sharedSecret,
  } as PairedDevice
}

beforeEach(() => {
  mockVerifyAuthProof.mockReset()
  mockVerifyAuthProof.mockReturnValue(true)
})

describe('LAN auth with an unusable stored pairing secret', () => {
  it('refuses a known device whose secret is still ciphertext', () => {
    const h = makeHarness(pairedDevice(CORRUPT_SECRET))

    handleLanAuthResponse(h.ctx, authResponse() as never, 'lan-1')

    expect(h.authenticated).toEqual([])
    expect(h.ctx.deviceSecrets.size).toBe(0)
    expect(h.disconnects).toHaveLength(1)
  })

  it('never reaches proof verification with a corrupt secret', () => {
    const h = makeHarness(pairedDevice(CORRUPT_SECRET))

    handleLanAuthResponse(h.ctx, authResponse() as never, 'lan-1')

    // The old code decoded the ciphertext to a wrong key and handed it to
    // HMAC, which accepts any key length and reported "invalid proof".
    expect(mockVerifyAuthProof).not.toHaveBeenCalled()
  })

  it('refuses with 4004, distinct from 4003 unknown device', () => {
    const h = makeHarness(pairedDevice(CORRUPT_SECRET))

    handleLanAuthResponse(h.ctx, authResponse() as never, 'lan-1')

    expect(h.disconnects[0].code).toBe(LAN_CLOSE_SECRET_UNUSABLE)
    expect(h.disconnects[0].code).not.toBe(LAN_CLOSE_UNKNOWN_DEVICE)
    // Still inside the application-close band iOS treats as definitive.
    expect(h.disconnects[0].code).toBeGreaterThanOrEqual(4000)
    expect(h.disconnects[0].code).toBeLessThanOrEqual(4999)
  })

  it('charges NO IP auth-failure penalty for a desktop-side fault', () => {
    const h = makeHarness(pairedDevice(CORRUPT_SECRET))

    handleLanAuthResponse(h.ctx, authResponse() as never, 'lan-1')

    // This is the regression: the penalty produced "auth-blocked
    // fail_count=2" against the phone and then blocked its own repair.
    expect(h.authFailures).toEqual([])
  })

  it('rejects a wrong-length secret the same way', () => {
    const h = makeHarness(pairedDevice(randomBytes(16).toString('base64')))

    handleLanAuthResponse(h.ctx, authResponse() as never, 'lan-1')

    expect(h.disconnects[0].code).toBe(LAN_CLOSE_SECRET_UNUSABLE)
    expect(h.authFailures).toEqual([])
    expect(mockVerifyAuthProof).not.toHaveBeenCalled()
  })
})

describe('LAN auth with a well-formed secret', () => {
  it('authenticates when the proof verifies', () => {
    const h = makeHarness(pairedDevice(GOOD_SECRET))
    mockVerifyAuthProof.mockReturnValue(true)

    handleLanAuthResponse(h.ctx, authResponse() as never, 'lan-1')

    expect(h.authenticated).toEqual(['dev-1'])
    expect(h.ctx.deviceSecrets.get('dev-1')).toHaveLength(32)
    expect(h.authSuccesses).toHaveLength(1)
    expect(h.disconnects).toEqual([])
  })

  it('DOES charge an IP penalty when a valid-shaped secret fails the proof', () => {
    const h = makeHarness(pairedDevice(GOOD_SECRET))
    mockVerifyAuthProof.mockReturnValue(false)

    handleLanAuthResponse(h.ctx, authResponse() as never, 'lan-1')

    // A genuine bad proof is a real bad actor: the backoff must still apply.
    expect(h.authFailures).toHaveLength(1)
    expect(h.disconnects[0].code).toBe(LAN_CLOSE_UNKNOWN_DEVICE)
    expect(h.disconnects[0].reason).toBe('invalid proof')
  })

  it('charges an IP penalty for a genuinely unknown device', () => {
    const h = makeHarness(null)

    handleLanAuthResponse(h.ctx, authResponse() as never, 'lan-1')

    expect(h.authFailures).toHaveLength(1)
    expect(h.disconnects[0].code).toBe(LAN_CLOSE_UNKNOWN_DEVICE)
    expect(h.disconnects[0].reason).toBe('unknown device')
  })
})
