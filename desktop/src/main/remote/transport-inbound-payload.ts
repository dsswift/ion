// Inbound payload decode for the desktop↔iOS wire, extracted from
// RemoteTransport._handleIncoming (transport.ts) to keep that file under the
// file-size cap, mirroring the transport-dedup.ts / transport-inbound-epoch.ts
// extraction pattern.

import { decrypt } from './crypto'
import { decompressPayload } from './transport-compression'
import { log as _log } from '../logger'
import type { WireMessage } from './protocol'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('RemoteTransport', msg, fields)
}

/**
 * Decode one inbound frame's payload to the plaintext JSON string.
 *
 * With a per-device secret set, encryption is mandatory: the ciphertext is
 * decrypted and (if 0x01-prefixed) DEFLATE-decompressed; a plaintext `payload`
 * field is rejected. Without a secret, the plaintext payload passes through.
 * Returns null on any failure (already logged) so the caller drops the frame.
 */
export function decodeInboundPayload(msg: WireMessage, secret: Buffer | undefined, deviceId: string): string | null {
  if (secret && msg.nonce && msg.ciphertext) {
    const decrypted = decrypt(msg.nonce, msg.ciphertext, secret)
    if (decrypted === null) {
      log('transport: decryption failed', { seq: msg.seq, device_id: deviceId })
      return null
    }
    // Check version prefix: 0x01 = deflate-compressed payload.
    // iOS does not currently send compressed payloads, but this
    // handles the case symmetrically for forward compatibility.
    try {
      return decompressPayload(decrypted)
    } catch (err) {
      log('transport: decompression failed', { seq: msg.seq, device_id: deviceId, error: (err as Error).message })
      return null
    }
  }
  if (secret && msg.payload) {
    // Shared secret is set but message is plaintext -- reject it.
    log('transport: rejecting plaintext', { seq: msg.seq, device_id: deviceId })
    return null
  }
  if (!msg.payload) {
    log('transport: no payload in message', { seq: msg.seq, device_id: deviceId })
    return null
  }
  return msg.payload
}
