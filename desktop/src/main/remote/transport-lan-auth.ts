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
  /** Start a new inbound-seq epoch for the device (iOS resets its outbound
   *  seq to 0 on every LAN auth; the dedup high-water mark AND seen-set must
   *  reset with it or the new epoch's low seqs are dropped as duplicates). */
  resetInboundSeq: (deviceId: string) => void
  getPairedDevice: (deviceId: string) => PairedDevice | null
  recomputeState: () => void
  emit: (event: string, ...args: unknown[]) => void
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

  ctx.resetInboundSeq(device.id)

  if (ip) ctx.lan?.recordAuthSuccess(ip)
  log('lan_auth: authenticated', { device_id: authResp.deviceId, device_name: device.name })
  sendAuthResult(ctx, device.id, true)

  ctx.recomputeState()
  ctx.emit('peer-connected')
}

export function sendAuthResult(ctx: LanAuthCtx, connectionId: string, success: boolean, reason?: string): void {
  const result: AuthResult = { type: 'auth_result', success, reason }
  ctx.lan?.sendRaw(JSON.stringify(result), connectionId)
}
