/**
 * Paired devices as a person reads them: which of their pairings exist and
 * which are connected right now. The pairing record says when a device last
 * connected; only the live connection registry says whether it is connected
 * now.
 */
import type { PairedDevice } from '@ion/shared/types-environment-admin'
import type { CredentialClientRecord } from './credentials-store'

/** The part of a live connection that ties it to a pairing. */
export interface LivePairing {
  pairedClientId: string | null
  isClosed: boolean
  connectedAt: number
}

/** When the pairing's longest-open live connection opened; null when none is open. */
export function connectedSince(clientId: string, live: readonly LivePairing[]): number | null {
  let since: number | null = null
  for (const conn of live) {
    if (conn.isClosed || conn.pairedClientId !== clientId) continue
    if (since === null || conn.connectedAt < since) since = conn.connectedAt
  }
  return since
}

/**
 * The live pairings of `subject`, newest first. `selfClientId` is the
 * pairing the caller is connected through, marked so a caller can leave
 * itself out.
 */
export function devicesOf(records: readonly CredentialClientRecord[], live: readonly LivePairing[], subject: string, selfClientId: string | null): PairedDevice[] {
  return records
    .filter((r) => r.revokedAt === null && r.subject === subject)
    .map((r): PairedDevice => {
      const since = connectedSince(r.clientId, live)
      return {
        clientId: r.clientId,
        label: r.label?.trim() ? r.label : null,
        kind: r.kind,
        pairedAt: r.createdAt,
        lastSeen: r.lastSeen,
        connected: since !== null,
        connectedAt: since,
        admin: r.scopes.includes('admin'),
        self: r.clientId === selfClientId,
      }
    })
    .sort((a, b) => b.pairedAt - a.pairedAt)
}
