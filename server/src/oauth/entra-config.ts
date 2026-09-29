/**
 * The OIDC identity CONFIGURATION readers: what engine.json's auth block says,
 * and nothing that talks to the engine. Split from entra-flow.ts so a process
 * that only needs to read the configuration (the desktop, at startup) does
 * not import the engine bridge with it -- that import is what gave the
 * desktop a second, connected engine bridge of its own (ADR-033: the Studio
 * server is the engine's one client).
 *
 * The identity used for OIDC flows is configuration, not code. Ion ships with
 * no default identity: a deployment provides one by writing the auth block
 * into ~/.ion/engine.json (auth.identityProvider + auth.oauth.<provider>) --
 * by hand, by installer, or by an MDM-managed configuration.
 */
import { existsSync } from 'fs'
import { engineConfigFile, readEngineConfig } from '@ion/server/persistence/settings-store'
import { getConfiguredOidcClientId } from '@ion/server/oauth/entra-auth'
import { log as _log } from '../logger'

export { getConfiguredOidcClientId }

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('entra_auth', msg, fields)
}

/**
 * The downstream telemetry scope for this install, derived from the
 * configured auth block: the first configured scope containing a '/'
 * (resource-scoped, e.g. api://<id>/Telemetry.Write). Entra requires a
 * resource-scoped scope on oidc_token or it returns AADSTS90009. Returns ''
 * when no identity or no resource scope is configured -- telemetry egress
 * is then unavailable, which is the honest state.
 */
export function getConfiguredTelemetryScope(): string {
  try {
    const cfg = readEngineConfig()
    const auth = (cfg.auth ?? {}) as Record<string, unknown>
    const provider = auth.identityProvider as string | undefined
    if (!provider) return ''
    const oauth = (auth.oauth ?? {}) as Record<string, unknown>
    const entry = oauth[provider] as Record<string, unknown> | undefined
    const scopes = (entry?.scopes as string[]) || []
    return scopes.find((s) => s.includes('/') && !s.startsWith('openid')) || ''
  } catch {
    return '' // silent-ok: unconfigured identity; telemetry egress simply disabled
  }
}

/**
 * Log the identity-configuration state at startup so an unconfigured install
 * is diagnosable from the log file alone. Never writes anything. Returns true
 * when an identity is configured.
 */
export function ensureEntraAuthConfig(): boolean {
  if (!existsSync(engineConfigFile())) return false
  try {
    const cfg = readEngineConfig()
    const auth = (cfg.auth ?? {}) as Record<string, unknown>
    const provider = auth.identityProvider as string | undefined
    if (provider) {
      log('entra_auth: identity configured', { provider })
      return true
    }
    log('entra_auth: no identity configured; OIDC sign-in unavailable until auth block is written to engine.json')
    return false
  } catch (err) {
    log('entra_auth: identity config check failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
