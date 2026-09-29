import type { RelayFailure } from './relay-failure'

export type RelayRejection =
  | { kind: 'expired' }
  | { kind: 'identity_mismatch'; failure: RelayFailure }
  | { kind: 'none' }

/** Classify relay-auth responses before a WebSocket upgrade completes. */
export function classifyRelayRejection(closeCode: number, httpStatus?: number): RelayRejection {
  if (httpStatus === 403) {
    return {
      kind: 'identity_mismatch',
      failure: {
        class: 'permanent',
        reason: 'identity_mismatch',
        detail: 'The relay channel belongs to a different signed-in identity.',
      },
    }
  }
  if (httpStatus === 401 || closeCode === 4401) return { kind: 'expired' }
  return { kind: 'none' }
}
