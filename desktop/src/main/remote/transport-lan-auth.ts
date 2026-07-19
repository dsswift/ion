import type { LANServer } from './lan-server'
import { createAuthNonce, verifyAuthProof } from './crypto'
import { log as _log } from '../logger'
import type { WireMessage, AuthChallenge, AuthResponse, AuthResult, PairedDevice } from './protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('RemoteTransport', msg, fields)
}

export interface LanAuthCtx {
  lan: LANServer | null
  lanAuthPending: Map<string, { nonce: string; timeout: ReturnType<typeof setTimeout> }>
  lanDeviceMap: Map<string, string>
  deviceSecrets: Map<string, Buffer>
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
      ctx.lan?.disconnectClient(connectionId, 4003, 'auth timeout')
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
    ctx.lan?.disconnectClient(connectionId, 4003, 'unknown device')
    return
  }

  const secret = Buffer.from(device.sharedSecret, 'base64')
  const valid = verifyAuthProof(pending.nonce, authResp.proof, secret)
  if (!valid) {
    log('lan_auth: invalid proof', { device_id: authResp.deviceId })
    sendAuthResult(ctx, connectionId, false, 'invalid proof')
    if (ip) ctx.lan?.recordAuthFailure(ip)
    ctx.lan?.disconnectClient(connectionId, 4003, 'invalid proof')
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

export function sendAuthResult(ctx: LanAuthCtx, connectionId: string, success: boolean, reason?: string): void {
  const result: AuthResult = { type: 'auth_result', success, reason }
  ctx.lan?.sendRaw(JSON.stringify(result), connectionId)
}
