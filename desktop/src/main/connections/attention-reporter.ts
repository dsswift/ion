/**
 * attention-reporter — tells every connected Environment whether this
 * desktop's window is focused (`presence.attention`).
 *
 * A server gates its background git work, the worktree freshness poll
 * included, on whether any client connected to it is attentive
 * (`server/src/protocol/presence.ts`). Attention is recorded per
 * connection and starts absent, so a server this desktop only visits keeps
 * its worktree rows frozen unless the desktop reports to it too. Reported on
 * every focus change to every Environment, and again to each Environment the
 * moment it welcomes a connection, because a new connection (a first
 * connect, a reconnect, a server restart) carries no attention until told.
 */
import type { Broker } from './broker'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'presence-attention'

function sendAttention(broker: Broker, environmentId: string, focused: boolean, reason: string): void {
  broker.sendAction(environmentId, 'presence.attention', [focused]).then(
    () => _log(TAG, 'attention reported', { environment_id: environmentId, focused, reason }),
    (err: unknown) => _warn(TAG, 'attention not delivered', { environment_id: environmentId, focused, reason, error: String(err) }),
  )
}

/**
 * Wires the welcome-time report, reports the current focus to every
 * Environment already connected (one may have welcomed before this ran),
 * and returns the focus-change reporter. `isFocused` reads the desktop's
 * current window focus.
 */
export function wireAttentionReporting(broker: Broker, isFocused: () => boolean): (focused: boolean) => void {
  broker.onFrame((environmentId, frame) => {
    if (frame.type !== 'studio_welcome') return
    sendAttention(broker, environmentId, isFocused(), 'welcome')
  })
  const focused = isFocused()
  for (const environmentId of broker.environmentIds()) sendAttention(broker, environmentId, focused, 'wired')
  return (focused) => {
    for (const environmentId of broker.environmentIds()) sendAttention(broker, environmentId, focused, 'focus-change')
  }
}
