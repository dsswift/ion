/**
 * relay-oidc-join -- how this server authenticates to a relay that uses its
 * own OIDC issuers, and what it announces for a paired device.
 *
 * A relay may accept several issuers, one per identity tenant its operator
 * signs in from. This server joins with a token from the tenant ITS operator
 * is signed in to: it reads the relay's issuer list, takes the entry whose
 * issuer is the operator's, and asks the engine for a token for that entry's
 * audience and scope.
 *
 * A paired device may be signed in to a different tenant than this server.
 * The relay binds a channel to the first subject on it (this server's), so
 * the device's own subject would be refused as a second owner. The device
 * said who it is when it paired; this server announces that identity on the
 * device's channel, and the relay admits exactly that subject.
 */
import { composeOidcScope, chooseRelayIssuer, selectRelayIssuer, relayIssuers, type RelayAuthConfig } from '@ion/shared/relay-auth-config'
import type { RelayIdentity } from '@ion/shared/studio-wire/relay-envelope'
import type { RelayAnnounceTrust } from './relay-client'
import { RelayCredentialSource } from './relay-credential-source'
import type { TokenResult } from './token-refresh'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('relay-oidc-join', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('relay-oidc-join', msg, fields)
}

/** The issuer this server last joined each OIDC relay with, by relay URL. */
const issuerInUse = new Map<string, string>()

/**
 * The issuer this server joins `relayUrl` with, or undefined before its first
 * join resolved one. A paired client is told it (`advertisedRelays`), because
 * the relay admits the client only as the same person from the same tenant.
 */
export function relayIssuerInUse(relayUrl: string): string | undefined {
  return issuerInUse.get(relayUrl)
}

export interface RelayOidcJoinDeps {
  probe: (relayUrl: string) => Promise<RelayAuthConfig | null>
  /** The issuer that signed the operator's identity; '' when signed out or unknown. */
  ownIssuer: () => Promise<string>
  requestToken: (oidcScope: string, forceRefresh: boolean) => Promise<TokenResult>
}

export interface RelayOidcJoin {
  getCredential: () => Promise<string>
  onCredentialRejected: () => void
}

/**
 * A credential factory for one OIDC relay. The relay entry is resolved on
 * the first connect and again after a rejection, because both inputs move:
 * the operator can sign in to another tenant, and the relay's list can gain
 * one. A failure throws with the reason.
 */
export function relayOidcJoin(relayUrl: string, deps: RelayOidcJoinDeps): RelayOidcJoin {
  let source: { scope: string; credentials: RelayCredentialSource } | null = null
  let stale = true

  const resolve = async (): Promise<void> => {
    const config = await deps.probe(relayUrl)
    if (!config || !config.oidc) throw new Error(`relay ${relayUrl} did not report an OIDC configuration`)
    const issuer = await deps.ownIssuer()
    if (!issuer && relayIssuers(config).length > 1) throw new Error('no operator identity is signed in, so there is no issuer to present to the relay')
    const entry = chooseRelayIssuer(config, issuer)
    if (!entry) {
      warn('relay does not accept the operator\'s issuer', { relay_url: relayUrl, issuer })
      throw new Error(`relay ${relayUrl} does not accept tokens from ${issuer}`)
    }
    issuerInUse.set(relayUrl, entry.issuer)
    const scope = composeOidcScope(entry.audience, entry.requiredScope)
    // An unchanged scope keeps its source, and with it a pending forced refresh.
    if (source?.scope !== scope) {
      log('relay issuer entry selected', { relay_url: relayUrl, issuer: entry.issuer, audience: entry.audience, scope })
      source = { scope, credentials: new RelayCredentialSource(scope, deps.requestToken, () => {}, warn) }
    }
  }

  return {
    getCredential: async () => {
      if (stale || !source) {
        await resolve()
        stale = false
      }
      if (!source) throw new Error(`relay ${relayUrl}: no issuer entry resolved`)
      return source.credentials.getCredential()
    },
    // A rejection is also what a changed tenant or a changed relay list
    // looks like, so the entry is resolved again before the next connect.
    onCredentialRejected: () => {
      source?.credentials.requestForcedRefresh()
      stale = true
    },
  }
}

/**
 * The announcement for a paired device's channel: the relay's entry for the
 * device's issuer, pinned to the device's subject. Undefined when the device
 * gave no identity (it then joins as this server's own subject or not at
 * all), or when the relay does not accept its issuer -- announcing an issuer
 * the relay refuses would turn every join into `issuer_not_trusted`.
 */
export function announceForDevice(config: RelayAuthConfig | null, identity: RelayIdentity | undefined, relayUrl: string): RelayAnnounceTrust | undefined {
  if (!identity) {
    log('no announcement: the device gave no identity when it paired', { relay_url: relayUrl })
    return undefined
  }
  const entry = config ? selectRelayIssuer(config, identity.issuer) : null
  if (!entry) {
    warn('no announcement: the relay does not accept the device\'s issuer', { relay_url: relayUrl, issuer: identity.issuer })
    return undefined
  }
  log('announcing the device\'s identity on its channel', { relay_url: relayUrl, issuer: entry.issuer, audience: entry.audience })
  return { issuer: entry.issuer, audience: entry.audience, scope: entry.requiredScope, subject: identity.subject }
}
