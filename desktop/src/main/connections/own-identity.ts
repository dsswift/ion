/**
 * own-identity -- who this desktop's operator is signed in as, asked of the
 * LOCAL server (`oidc.identity`, which reads the engine's identity).
 *
 * Two callers need it. Pairing tells the other server who will be joining
 * its relay channel, so that server can have an OIDC relay admit this
 * identity even from another tenant. A relay join picks, from the issuers
 * the relay accepts, the one this operator is signed in to.
 */
import { isRelayIdentity, type RelayIdentity } from '@ion/shared/studio-wire/relay-envelope'
import type { ActionSender } from './token-source'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('connections-own-identity', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('connections-own-identity', msg, fields)
}

/**
 * The operator's issuer and subject, or null when signed out, when the local
 * server cannot say, or when it is an older server without the action. Never
 * throws: a desktop with no identity still pairs and still joins PSK relays.
 */
export async function ownRelayIdentity(sender: ActionSender, localEnvironmentId: string): Promise<RelayIdentity | null> {
  try {
    const value = await sender.sendAction(localEnvironmentId, 'oidc.identity', [])
    if (!isRelayIdentity(value)) {
      log('no operator identity to present', { signed_in: false })
      return null
    }
    log('operator identity resolved', { issuer: value.issuer })
    return value
  } catch (err) {
    warn('operator identity unavailable from the local server', { error: String(err) })
    return null
  }
}
