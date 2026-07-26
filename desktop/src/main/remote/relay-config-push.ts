/**
 * relay-config-push.ts — the single path that pushes `desktop_relay_config`
 * to paired iOS devices, plus the in-memory record of the relay auth mode the
 * desktop actually resolved.
 *
 * ## Why this module exists
 *
 * The desktop learns its relay auth mode two ways: from `settings.json` at
 * init, or from `probeRelayAuthConfig` when the stored mode is stale/absent.
 * The *live transport* is built from whichever of those won, but the iOS push
 * used to re-read `settings.json` independently. Those two sources diverged in
 * production and shipped a broken credential to the phone:
 *
 *   1. The relay probe resolved OIDC and persisted the four `relayOidc*` keys.
 *   2. A later renderer SAVE_SETTINGS full-object write dropped them (the
 *      renderer's payload has a fixed key list that omits them).
 *   3. The next peer-connect read `relayAuthMode` from disk, got `undefined`,
 *      fell through to the PSK branch, and sent
 *      `{ relayUrl, relayApiKey: '' }` — because OIDC mode deliberately clears
 *      the stored PSK.
 *   4. iOS persisted that empty credential into its keychain, wiping the
 *      pairing's relay record, and could no longer reconnect over the relay.
 *
 * The settings clobber is fixed at its own root (`ipc/settings.ts` merges over
 * disk and treats the OIDC keys as main-owned). This module closes the second
 * half: the push reads the *resolved* auth mode the transport is actually
 * using, and it never sends a credential-less PSK config at all.
 *
 * Both push call sites — the peer-connected handler in `transport-init.ts` and
 * the relay-settings-change handler in `ipc/settings.ts` — go through
 * `sendRelayConfigToPeers` here. One code path, one log prefix.
 */

import { log as _log, warn as _warn } from '../logger'
import { state, engineBridge } from '../state'
import { readSettings } from '../settings-store'
import { composeOidcScope } from './relay-auth'
import { getConfiguredOidcClientId } from '../oauth/entra-auth'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('relay_config_push', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('relay_config_push', msg, fields)
}

/**
 * The relay auth configuration the desktop actually resolved for the running
 * transport. Set wherever the OIDC credential factory is built (init-time from
 * stored settings, or after the async probe upgrades the transport in place).
 *
 * Authoritative over `settings.json` for the iOS push: settings can be stale
 * (a renderer write that predates the probe) while this reflects the
 * credential the desktop's own relay connection is using right now.
 */
export interface ResolvedRelayAuth {
  mode: 'oidc'
  issuer: string
  audience: string
  /** Already composed: `api://<audience>/<scope>`. */
  scope: string
}

let resolvedRelayAuth: ResolvedRelayAuth | null = null

/**
 * Record the OIDC auth config the transport resolved. Called from both places
 * `transport-init` builds a credential factory.
 */
export function setResolvedRelayAuth(auth: ResolvedRelayAuth): void {
  resolvedRelayAuth = auth
  log('relay_config_push: resolved relay auth recorded', {
    mode: auth.mode,
    issuer: auth.issuer,
    scope: auth.scope,
  })
}

/**
 * Clear the resolved auth state. Called when the transport is torn down so a
 * subsequent PSK-mode init doesn't inherit a previous OIDC resolution.
 */
export function clearResolvedRelayAuth(): void {
  if (resolvedRelayAuth !== null) {
    log('relay_config_push: resolved relay auth cleared')
  }
  resolvedRelayAuth = null
}

/** Current resolved auth, or null when the transport is PSK / not yet resolved. */
export function getResolvedRelayAuth(): ResolvedRelayAuth | null {
  return resolvedRelayAuth
}

/**
 * Resolve the effective relay auth mode: the in-memory resolution first, then
 * the stored `relayAuthMode`. Returns the OIDC parameters when either source
 * says OIDC, otherwise null (PSK).
 *
 * `settings` is passed in so callers that already read it don't pay for a
 * second disk read.
 */
export function resolveRelayAuthMode(settings: Record<string, unknown>): ResolvedRelayAuth | null {
  if (resolvedRelayAuth) return resolvedRelayAuth

  if ((settings.relayAuthMode as string | undefined) === 'oidc') {
    const audience = (settings.relayOidcAudience as string) || ''
    return {
      mode: 'oidc',
      issuer: (settings.relayOidcIssuer as string) || '',
      audience,
      // composeOidcScope is idempotent — an already-composed stored value
      // passes through unchanged.
      scope: composeOidcScope(audience, (settings.relayOidcRequiredScope as string) || ''),
    }
  }

  return null
}

/** Outcome of a relay-config push attempt. */
export interface RelayConfigPushResult {
  /** True when a config was actually written to the wire. */
  sent: boolean
  /**
   * Expiry (epoch ms) of the freshly-minted OIDC token, when one was minted.
   * Callers use it to schedule the next proactive refresh. Absent in PSK mode
   * and when the mint failed.
   */
  expiresAt?: number
  /**
   * The COMPOSED scope the token was minted against, returned alongside
   * expiresAt so a caller scheduling the refresh mints against the same scope
   * this push used. Reading the scope back out of resolved-auth state instead
   * would let the two diverge — and a refresh armed with an empty scope fails
   * at mint time and silently ends the refresh chain, since there is no
   * re-schedule on that path.
   */
  scope?: string
}

/**
 * Build and send `desktop_relay_config` to every paired device.
 *
 * OIDC mode mints a fresh bearer token to seed iOS's first connection (iOS
 * acquires its own tokens thereafter via OIDCTokenManager). PSK mode sends the
 * stored key.
 *
 * **Never sends a config without a usable credential.** An empty `relayApiKey`
 * is not merely useless to iOS — `handleRelayConfig` on the phone persists the
 * incoming values onto the paired-device record, so an empty push actively
 * destroys a working relay pairing. When no credential can be produced the send
 * is skipped and the reason is logged; the phone keeps whatever it already has
 * and stays reachable over LAN.
 *
 * @param reason Call-site tag for the log line (e.g. 'peer-connected').
 */
export async function sendRelayConfigToPeers(reason: string): Promise<RelayConfigPushResult> {
  if (!state.remoteTransport) {
    log('relay_config_push: skipped, no transport', { reason })
    return { sent: false }
  }

  const settings = readSettings()
  const relayUrl = (settings.relayUrl as string) || ''
  if (!relayUrl) {
    log('relay_config_push: skipped, no relay URL configured', { reason })
    return { sent: false }
  }

  const oidc = resolveRelayAuthMode(settings)

  if (oidc) {
    // Mint a fresh token for the bootstrap connection. The credential lives in
    // the desktop's in-memory factory, not in settings, so the stored
    // relayApiKey is empty in OIDC mode and cannot serve as a fallback.
    let freshToken = ''
    let expiresAt: number | undefined
    try {
      const result = await engineBridge.request<{ accessToken?: string; expiresAt?: number }>(
        'oidc_token',
        { oidcScope: oidc.scope },
      )
      if (result.ok && result.data?.accessToken) {
        freshToken = result.data.accessToken
        expiresAt = result.data.expiresAt
      } else {
        warn('relay_config_push: OIDC token mint failed', {
          reason,
          error: result.error ?? 'no token returned',
        })
      }
    } catch (err) {
      warn('relay_config_push: OIDC token mint threw', { reason, error: String(err) })
    }

    if (!freshToken) {
      // Sending an empty credential would overwrite the phone's stored relay
      // config with nothing. Skip: iOS keeps its working config and can still
      // mint its own token against the issuer it already has.
      warn('relay_config_push: suppressed, no credential to send', {
        reason,
        auth_mode: 'oidc',
      })
      return { sent: false }
    }

    state.remoteTransport.send({
      type: 'desktop_relay_config',
      relayUrl,
      relayApiKey: freshToken,
      authMode: 'oidc',
      relayOidcIssuer: oidc.issuer,
      relayOidcAudience: oidc.audience,
      // Always the COMPOSED scope — iOS passes it verbatim to Entra.
      relayOidcRequiredScope: oidc.scope,
      relayOidcClientId: getConfiguredOidcClientId(),
    })
    log('relay_config_push: sent', { reason, auth_mode: 'oidc' })
    return { sent: true, expiresAt, scope: oidc.scope }
  }

  const relayApiKey = (settings.relayApiKey as string) || ''
  if (!relayApiKey) {
    // Same rule as the OIDC branch: an empty PSK push wipes the phone's stored
    // relay credential. This is the exact shape that broke reconnection —
    // OIDC-resolved transport, stale/absent relayAuthMode on disk, empty
    // stored PSK, and a push that carried nothing.
    warn('relay_config_push: suppressed, no credential to send', {
      reason,
      auth_mode: 'psk',
    })
    return { sent: false }
  }

  state.remoteTransport.send({
    type: 'desktop_relay_config',
    relayUrl,
    relayApiKey,
  })
  log('relay_config_push: sent', { reason, auth_mode: 'psk' })
  return { sent: true }
}
