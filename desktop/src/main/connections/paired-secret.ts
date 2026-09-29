/**
 * The plaintext shape stored under a `paired` credential in
 * `desktop-connections.json` (`credentials.ts`, encrypted at rest).
 *
 * A paired connection needs TWO things the pairing exchange produced: the
 * X25519 shared secret (keys the HMAC proof and, over a relay, the channel
 * id and every envelope) and the `clientId` the server registered the
 * secret under (`server/src/auth/pairing-links.ts#completePairing` derives
 * it from the shared secret and stores the credential record by it). The
 * proof is verified by looking the record up BY clientId, so a
 * `studio_hello` that carries any other client id -- a per-process UUID,
 * say -- is refused `unauthorized` before the proof is even checked. Both
 * parts travel together so the connect path cannot present one without
 * the other.
 *
 * v2 adds the relays the server advertised at pairing time (`relays`), so
 * a later connect can fall back to a relay when the LAN address is
 * unreachable without the relay key ever appearing in a link or a
 * settings screen. A v1 record still decodes (no relays).
 *
 * `directAddresses` are the LAN addresses the server reported at its last
 * welcome (`direct-route.ts`), so a server that moved to another network can
 * still be found without a relay. Optional inside v2: a record without them
 * decodes as before.
 */
import type { EnvironmentRelay } from '@ion/shared/studio-wire/relay-envelope'
import { isEnvironmentRelay } from '@ion/shared/studio-wire/relay-envelope'

export interface PairedSecret {
  clientId: string
  /** Raw X25519 shared secret bytes. */
  sharedSecret: Buffer
  /** Relays the server said it is reachable through, with how to authenticate to each. */
  relays?: EnvironmentRelay[]
  /** Where the server said it answers directly, as of its last welcome. */
  directAddresses?: string[]
}

/** Keeps only strings that parse as a URL; a stored list is never trusted blindly. */
export function sanitizeDirectAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => {
    if (typeof entry !== 'string') return false
    try {
      return ['http:', 'https:', 'ws:', 'wss:'].includes(new URL(entry).protocol)
    } catch {
      return false // silent-ok: a malformed entry is dropped; the caller logs what it kept
    }
  })
}

export function encodePairedSecret(secret: PairedSecret): string {
  const relays = (secret.relays ?? []).filter(isEnvironmentRelay)
  const directAddresses = sanitizeDirectAddresses(secret.directAddresses)
  return JSON.stringify({
    v: 2, clientId: secret.clientId, sharedSecret: secret.sharedSecret.toString('base64'), relays,
    ...(directAddresses.length > 0 ? { directAddresses } : {}),
  })
}

/** Returns null when the stored plaintext is not a v1 or v2 paired-secret record. */
export function decodePairedSecret(plaintext: string): PairedSecret | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as { v?: unknown; clientId?: unknown; sharedSecret?: unknown; relays?: unknown; directAddresses?: unknown }
  if ((record.v !== 1 && record.v !== 2) || typeof record.clientId !== 'string' || !record.clientId || typeof record.sharedSecret !== 'string') return null
  const sharedSecret = Buffer.from(record.sharedSecret, 'base64')
  if (sharedSecret.length === 0) return null
  const relays = Array.isArray(record.relays) ? record.relays.filter(isEnvironmentRelay) : []
  const directAddresses = sanitizeDirectAddresses(record.directAddresses)
  return {
    clientId: record.clientId,
    sharedSecret,
    ...(relays.length > 0 ? { relays } : {}),
    ...(directAddresses.length > 0 ? { directAddresses } : {}),
  }
}
