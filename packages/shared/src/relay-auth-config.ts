/**
 * relay-auth-config -- what a relay says about how to authenticate to it
 * (`GET /v1/auth/config`), and how a client signed in to one identity tenant
 * picks its own entry when the relay accepts several.
 *
 * Shared because both ends of a Studio relay channel do this: the hosting
 * server before it joins as `ion`, and the joining desktop before it joins
 * as `mobile`.
 */

/** One issuer the relay accepts, with the audience and scope a token from it must carry. */
export interface RelayIssuer {
  issuer: string
  audience: string
  requiredScope: string
}

/** Auth configuration advertised by the relay at GET /v1/auth/config. */
export interface RelayAuthConfig {
  /** True when the relay requires an OIDC bearer token for auth. */
  oidc: boolean
  /** The primary issuer (e.g. https://login.microsoftonline.com/<tenantId>/v2.0). */
  issuer: string
  /** The primary issuer's OAuth2 audience (app registration client ID). */
  audience: string
  /** The primary issuer's scope component after the audience (e.g. "Relay.Access"). */
  requiredScope: string
  /** True when the relay also accepts a pre-shared key. */
  psk: boolean
  /** Every accepted issuer, primary first. Absent from a relay that accepts one. */
  issuers?: RelayIssuer[]
}

function isRelayIssuer(v: unknown): v is RelayIssuer {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.issuer === 'string' && typeof r.audience === 'string' && (r.requiredScope === undefined || typeof r.requiredScope === 'string')
}

/**
 * Validates a `GET /v1/auth/config` body. A PSK-only relay omits the OIDC
 * fields entirely, so they read as empty strings rather than failing the
 * whole response.
 */
export function parseRelayAuthConfig(value: unknown): RelayAuthConfig | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.oidc !== 'boolean' || typeof v.psk !== 'boolean') return null
  for (const key of ['issuer', 'audience', 'requiredScope'] as const) {
    if (v[key] !== undefined && typeof v[key] !== 'string') return null
  }
  let issuers: RelayIssuer[] | undefined
  if (v.issuers !== undefined) {
    if (!Array.isArray(v.issuers) || !v.issuers.every(isRelayIssuer)) return null
    issuers = v.issuers.map((i) => ({ issuer: i.issuer, audience: i.audience, requiredScope: i.requiredScope ?? '' }))
  }
  return {
    oidc: v.oidc,
    psk: v.psk,
    issuer: (v.issuer as string | undefined) ?? '',
    audience: (v.audience as string | undefined) ?? '',
    requiredScope: (v.requiredScope as string | undefined) ?? '',
    ...(issuers ? { issuers } : {}),
  }
}

/** Every issuer the relay accepts, primary first. A relay that lists none has exactly its top-level one. */
export function relayIssuers(config: RelayAuthConfig): RelayIssuer[] {
  if (config.issuers && config.issuers.length > 0) return config.issuers
  if (!config.oidc || !config.issuer) return []
  return [{ issuer: config.issuer, audience: config.audience, requiredScope: config.requiredScope }]
}

/**
 * The relay entry for the issuer a client is signed in to, or null when the
 * relay does not accept that issuer. An exact match only: a token is
 * validated against the entry whose issuer equals its `iss`, so a near match
 * would mint a token the relay refuses.
 */
export function selectRelayIssuer(config: RelayAuthConfig, ownIssuer: string): RelayIssuer | null {
  if (!ownIssuer) return null
  return relayIssuers(config).find((i) => i.issuer === ownIssuer) ?? null
}

/**
 * The relay entry a client presents a token for. A relay that accepts one
 * issuer leaves nothing to choose: that entry, whatever `ownIssuer` says,
 * because an identity provider's id_token and access token may not spell the
 * issuer identically and the relay is the judge either way. A relay that
 * accepts several needs the match, and null means it accepts none of them
 * for this client.
 */
export function chooseRelayIssuer(config: RelayAuthConfig, ownIssuer: string): RelayIssuer | null {
  const accepted = relayIssuers(config)
  if (accepted.length === 1) return accepted[0]
  return selectRelayIssuer(config, ownIssuer)
}

/**
 * Compose the full OIDC scope string from audience + requiredScope.
 *
 * Entra convention: `api://<audience>/<requiredScope>`.
 * Example: audience="abc123", requiredScope="Relay.Access"
 *          → "api://abc123/Relay.Access"
 *
 * If requiredScope already contains a slash (i.e., the relay already sends the
 * full scope), return it verbatim.
 */
export function composeOidcScope(audience: string, requiredScope: string): string {
  if (requiredScope.includes('/') || requiredScope.startsWith('api://')) {
    return requiredScope
  }
  // Audience may already carry the api:// prefix (e.g. "api://<relay-app-id>").
  // Don't double-prefix it.
  if (audience.startsWith('api://')) {
    return `${audience}/${requiredScope}`
  }
  return `api://${audience}/${requiredScope}`
}
