// transport-relay-failure.ts — relay permanent-failure accessors.
//
// Split out of transport.ts, which is at its 600-line cap. These are pure
// functions over the relay map so the transport class keeps one-line members
// and the logic stays testable without constructing a transport.

import type { RelayClient } from './relay-client'
import type { RelayFailure } from './relay-failure'

/**
 * The first latched permanent failure across paired devices, if any.
 *
 * Surfaced so the settings UI can show WHY the relay is down. Without it the
 * operator sees only "Disconnected" and has to read engine.jsonl to learn that
 * they are simply not signed in.
 *
 * First-wins rather than aggregated: every device shares one relay config, so
 * a permanent failure is almost always the same cause on all of them, and one
 * actionable reason beats a list saying the same thing N times.
 */
export function firstRelayFailure(relays: Map<string, RelayClient>): RelayFailure | null {
  for (const [, relay] of relays) {
    const failure = relay.getFailure()
    if (failure) return failure
  }
  return null
}

/** Clear permanent latches and reconnect. Called after a sign-in or config edit. */
export function retryAllRelays(relays: Map<string, RelayClient>): void {
  for (const [, relay] of relays) relay.retry()
}
