import type { LANServer } from './lan-server'
import { createAuthNonce, verifyAuthProof } from './crypto'
import { decodeSharedSecret, describeSecretFailure } from './device-secret'
import {
  LAN_AUTH_REASON_SECRET_UNUSABLE,
  LAN_CLOSE_SECRET_UNUSABLE,
  LAN_CLOSE_UNKNOWN_DEVICE,
} from './protocol'
import { log as _log, error as _error } from '../logger'
import type { WireMessage, AuthChallenge, AuthResponse, AuthResult, PairedDevice } from './protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('RemoteTransport', msg, fields)
}

function error(msg: string, fields?: Record<string, unknown>): void {
  _error('RemoteTransport', msg, fields)
}

export interface LanAuthCtx {
  lan: LANServer | null
  lanAuthPending: Map<string, { nonce: string; timeout: ReturnType<typeof setTimeout> }>
  lanDeviceMap: Map<string, string>
  deviceSecrets: Map<string, Buffer>
  /** Push the current secret set to the crypto worker. MUST be called after
   *  any deviceSecrets mutation — the worker holds its own copy and frames
   *  fail to build ("no secret for device") for any device it doesn't know. */
  syncWorkerSecrets: () => void
  getPairedDevice: (deviceId: string) => PairedDevice | null
  recomputeState: () => void
  emit: (event: string, ...args: unknown[]) => void
  /** Called after a device completes LAN auth (state recomputed, socket
   *  rekeyed). The transport sends an immediate heartbeat here so the new
   *  LAN socket carries proof of life right away — iOS's resume probe waits
   *  only 3s for a LAN-delivered frame before tearing the socket down. */
  onAuthenticated?: (deviceId: string) => void
}

export function startLanAuth(ctx: LanAuthCtx, connectionId: string): void {
  const nonce = createAuthNonce()

  const challenge: AuthChallenge = {
    type: 'auth_challenge',
    nonce,
  }
  ctx.lan?.sendRaw(JSON.stringify(challenge), connectionId)

  const timeout = setTimeout(() => {
    if (ctx.lanAuthPending.has(connectionId)) {
      log('lan_auth: timed out', { connection_id: connectionId })
      ctx.lanAuthPending.delete(connectionId)
      const ip = ctx.lan?.getClientIp(connectionId)
      if (ip) ctx.lan?.recordAuthFailure(ip)
      ctx.lan?.disconnectClient(connectionId, LAN_CLOSE_UNKNOWN_DEVICE, 'auth timeout')
    }
  }, 10_000)

  ctx.lanAuthPending.set(connectionId, { nonce, timeout })
}

export function handleLanAuthResponse(ctx: LanAuthCtx, msg: WireMessage, connectionId: string): void {
  let authResp: AuthResponse | null = null
  try {
    if (msg.payload) {
      const parsed = JSON.parse(msg.payload)
      if (parsed.type === 'auth_response') {
        authResp = parsed as AuthResponse
      }
    }
  } catch { /* not valid JSON */ }

  if (!authResp) {
    log('LAN auth: received non-auth message during handshake, ignoring')
    return
  }

  const pending = ctx.lanAuthPending.get(connectionId)
  if (!pending) {
    log('lan_auth: no active nonce', { connection_id: connectionId })
    sendAuthResult(ctx, connectionId, false, 'no active challenge')
    return
  }

  const ip = ctx.lan?.getClientIp(connectionId)

  const device = ctx.getPairedDevice(authResp.deviceId)
  if (!device) {
    log('lan_auth: unknown device', { device_id: authResp.deviceId })
    sendAuthResult(ctx, connectionId, false, 'unknown device')
    if (ip) ctx.lan?.recordAuthFailure(ip)
    ctx.lan?.disconnectClient(connectionId, LAN_CLOSE_UNKNOWN_DEVICE, 'unknown device')
    return
  }

  const decoded = decodeSharedSecret(device.sharedSecret)
  if (!decoded.ok) {
    // The stored secret is unusable — a DESKTOP-side fault (most commonly a
    // safeStorage grant lost across a reinstall), not a bad actor. Two things
    // follow from that attribution:
    //
    //  1. No `recordAuthFailure(ip)`. Charging the phone's IP an exponential
    //     backoff for our own corrupt record is what produced the observed
    //     "auth-blocked fail_count=2" — the cooldown then obstructed the very
    //     re-pair that repairs it. A well-formed secret that fails HMAC below
    //     still gets the penalty; that one is a genuine bad proof.
    //  2. A distinct close code, so iOS can tell "your pairing is broken,
    //     re-pair" apart from "unknown device". Both are definitive
    //     rejections in the 4000-4999 range, but only this one is
    //     self-repairable without the user re-entering a PIN.
    error('lan_auth: stored pairing secret unusable, refusing and requesting re-pair', {
      device_id: authResp.deviceId,
      device_name: device.name,
      reason: decoded.reason,
      detail: describeSecretFailure(decoded.reason),
      decoded_bytes: decoded.byteLength,
    })
    sendAuthResult(
      ctx,
      connectionId,
      false,
      'pairing secret unusable',
      LAN_AUTH_REASON_SECRET_UNUSABLE,
    )
    ctx.lan?.disconnectClient(connectionId, LAN_CLOSE_SECRET_UNUSABLE, 'pairing secret unusable')
    return
  }

  const secret = decoded.secret
  const valid = verifyAuthProof(pending.nonce, authResp.proof, secret)
  if (!valid) {
    log('lan_auth: invalid proof', { device_id: authResp.deviceId })
    sendAuthResult(ctx, connectionId, false, 'invalid proof')
    if (ip) ctx.lan?.recordAuthFailure(ip)
    ctx.lan?.disconnectClient(connectionId, LAN_CLOSE_UNKNOWN_DEVICE, 'invalid proof')
    return
  }

  clearTimeout(pending.timeout)
  ctx.lanAuthPending.delete(connectionId)

  ctx.lan?.rekeyClient(connectionId, device.id)
  // Map both the original lan-N connectionId (used by the message handler
  // closure) and the rekeyed device.id (used by the close handler after
  // it finds the ws under its new key) to the device.
  ctx.lanDeviceMap.set(connectionId, device.id)
  ctx.lanDeviceMap.set(device.id, device.id)

  ctx.deviceSecrets.set(device.id, secret)
  // Sync the crypto worker's secret copy. Without this, the worker (which
  // builds ALL broadcast frames: snapshots, heartbeats, relay_config) fails
  // every frame for this device with "no secret for device" — the desktop
  // logs "snapshot payload" (queued) but nothing reaches the wire. This was
  // the root cause of iOS connecting via LAN auth but never receiving a
  // snapshot: main-thread secrets had the device, the worker's copy did not.
  ctx.syncWorkerSecrets()

  // No inbound-dedup reset here. iOS's outbound seq is continuous for the
  // life of its TransportManager instance — a LAN re-auth does NOT restart
  // its seq space. Resetting on auth was the re-poisoning vector: one stale
  // high-seq frame arriving after the reset re-established the old high-water
  // and the dedup then ate every subsequent command as "beyond window". The
  // reset trigger is a NEWER WireMessage.epoch on an inbound frame (a new iOS
  // transport generation), handled in RemoteTransport._handleIncoming.

  if (ip) ctx.lan?.recordAuthSuccess(ip)
  log('lan_auth: authenticated', { device_id: authResp.deviceId, device_name: device.name })
  sendAuthResult(ctx, device.id, true)

  ctx.recomputeState()
  ctx.emit('peer-connected')
  // Immediate proof-of-life AFTER recomputeState so _deliverFrame routes the
  // heartbeat over the just-authenticated LAN socket.
  ctx.onAuthenticated?.(device.id)
}

export function sendAuthResult(
  ctx: LanAuthCtx,
  connectionId: string,
  success: boolean,
  reason?: string,
  reasonCode?: AuthResult['reasonCode'],
): void {
  const result: AuthResult = { type: 'auth_result', success, reason, reasonCode }
  ctx.lan?.sendRaw(JSON.stringify(result), connectionId)
}
