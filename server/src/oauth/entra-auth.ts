/**
 * entra-auth.ts (server) — the pure, non-Electron-bound half of the
 * desktop's `oauth/entra-auth.ts`.
 *
 * The desktop file also orchestrates `shell.openExternal` for the
 * interactive sign-in step, which keeps the full module Electron-bound and
 * ineligible to move here wholesale. `getConfiguredOidcClientId` has no such
 * dependency — it only reads the auth block out of `engine.json`. Extracted
 * here as the single implementation.
 */
import { readEngineConfig } from '../persistence/settings-store'

/**
 * The configured OIDC client ID for this install, read from engine.json's
 * auth block (auth.oauth.<identityProvider>.clientId). Returns '' when no
 * identity is configured. A paired client is told it for an OIDC relay, so
 * it signs in as the same app registration this install does.
 */
export function getConfiguredOidcClientId(): string {
  try {
    const cfg = readEngineConfig()
    const auth = (cfg.auth ?? {}) as Record<string, unknown>
    const provider = auth.identityProvider as string | undefined
    if (!provider) return ''
    const oauth = (auth.oauth ?? {}) as Record<string, unknown>
    const entry = oauth[provider] as Record<string, unknown> | undefined
    return (entry?.clientId as string) || ''
  } catch {
    return '' // silent-ok: no identity configured is a valid state; callers treat '' as unconfigured
  }
}
