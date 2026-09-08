/**
 * Desktop log-egress bootstrap, split out of `app-lifecycle.ts` to keep that
 * file under the size cap. Two independent sources can turn egress on: the
 * merged engine.json (which enterprise policy may seal) and the operator's
 * own settings.json. Both are complete no-ops when their logging block is
 * absent, so a default install ships nothing.
 */

import { existsSync, readFileSync } from 'fs'
import { log as _log } from './logger'
import { ENGINE_CONFIG_FILE, readSettings } from './settings-store'
import { configureEgress, setEgressUser, type EgressConfig, type AuthHeaderProvider } from './log-egress'
import { startEgressTailers } from './log-egress-tailer'
import { getAccessToken, getSignedInIdentity } from './oauth/entra-auth'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/**
 * Read egress config from engine.json (logging.egressTargets / egressEndpoint etc.)
 * and configure the desktop egress forwarder.
 *
 * Nil/absent egress config = complete no-op (default installs unchanged). Enterprise
 * enforcement (EnforceEnterprise in the engine) can seal egress on via
 * enterprise.logging.egressTargets; the desktop respects whatever the merged
 * engine.json contains.
 */
export function initEgressFromEngineConfig(): void {
  if (!existsSync(ENGINE_CONFIG_FILE)) return
  try {
    const raw = JSON.parse(readFileSync(ENGINE_CONFIG_FILE, 'utf-8')) as Record<string, unknown>
    const logging = raw.logging as Record<string, unknown> | undefined
    if (!logging) return

    const targets = logging.egressTargets as string[] | undefined
    if (!Array.isArray(targets) || targets.length === 0) return

    const cfg: EgressConfig = {
      egressTargets: targets,
      egressEndpoint: typeof logging.egressEndpoint === 'string' ? logging.egressEndpoint : undefined,
      egressHeaders: typeof logging.egressHeaders === 'object' && logging.egressHeaders !== null
        ? logging.egressHeaders as Record<string, string>
        : undefined,
      egressBatchSize: typeof logging.egressBatchSize === 'number' ? logging.egressBatchSize : undefined,
      egressFlushIntervalMs: typeof logging.egressFlushIntervalMs === 'number' ? logging.egressFlushIntervalMs : undefined,
      egressOtel: typeof logging.egressOtel === 'object' && logging.egressOtel !== null
        ? logging.egressOtel as import('./log-egress').EgressOtelConfig
        : undefined,
    }

    // Shipping-responsibility matrix: the desktop's share is
    // logging.egressClientShipSources. Unset preserves the legacy
    // single-collection-point default (the desktop ships everything).
    const rawClientSources = logging.egressClientShipSources
    const clientSources: string[] = Array.isArray(rawClientSources)
      ? (rawClientSources as string[])
      : ['desktop', 'engine', 'ios', 'telemetry']
    if (clientSources.length === 0) {
      log('app_lifecycle: matrix assigns the desktop no sources; egress left to the engine', { targets })
      return
    }

    // OIDC header provider: called at every flush for a fresh token. The
    // engine owns the grant and mints ephemeral access tokens on demand
    // (oidc_token). Returns {} when signed out / unconfigured, so egress
    // still functions against a no-auth sink and simply receives 401 from
    // an authenticated sink until the user completes sign-in.
    const oidcHeaderProvider: AuthHeaderProvider = async () => {
      try {
        const token = await getAccessToken()
        if (token) return { Authorization: `Bearer ${token}` }
      } catch (err) {
        log('app_lifecycle: OIDC access token read failed; continuing without authorization', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return {} as Record<string, string>
    }

    configureEgress(cfg, oidcHeaderProvider, {
      shipOwnRecords: clientSources.includes('desktop'),
      source: 'engine',
    })
    // F4: populate user-attribution field on egress records. Read the signed-in
    // identity (from the engine's snapshot) so the field is set before the first
    // flush. If not signed in yet, the field remains absent (omitted by default).
    getSignedInIdentity().then((identity) => {
      if (identity) setEgressUser(identity.user)
    }).catch((err) => log("app_lifecycle: egress user identity read failed", { error: String(err) }))
    startEgressTailers(clientSources)
    log('app_lifecycle: egress configured', { targets, sources: clientSources })
  } catch (err) {
    log('app_lifecycle: egress config read failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Read egress config from settings.json (logging.egressTargets / egressOtel etc.)
 * and configure the desktop egress forwarder.
 *
 * This is the desktop-owned shipping path, separate from the engine's own
 * egress config in engine.json. When configured here, the desktop ships all
 * four local log sources (desktop, engine, iOS, telemetry) to the specified
 * endpoint under its own authenticated identity. The engine ships nothing unless
 * it has its own egressTargets set in engine.json — the two are independent.
 *
 * Nil/absent logging block = complete no-op.
 */
export function initEgressFromSettingsConfig(): void {
  try {
    const raw = readSettings()
    const logging = raw.logging as Record<string, unknown> | undefined
    if (!logging) return

    const targets = logging.egressTargets as string[] | undefined
    if (!Array.isArray(targets) || targets.length === 0) return

    const cfg: EgressConfig = {
      egressTargets: targets,
      egressEndpoint: typeof logging.egressEndpoint === 'string' ? logging.egressEndpoint : undefined,
      egressHeaders: typeof logging.egressHeaders === 'object' && logging.egressHeaders !== null
        ? logging.egressHeaders as Record<string, string>
        : undefined,
      egressBatchSize: typeof logging.egressBatchSize === 'number' ? logging.egressBatchSize : undefined,
      egressFlushIntervalMs: typeof logging.egressFlushIntervalMs === 'number' ? logging.egressFlushIntervalMs : undefined,
      egressOtel: typeof logging.egressOtel === 'object' && logging.egressOtel !== null
        ? logging.egressOtel as import('./log-egress').EgressOtelConfig
        : undefined,
    }

    // OIDC header provider: called at every flush for a fresh token.
    // Returns {} when signed out / unconfigured — egress still functions
    // against a no-auth sink and receives 401 from an authenticated sink
    // until the user completes sign-in.
    const oidcHeaderProvider: AuthHeaderProvider = async () => {
      try {
        const token = await getAccessToken()
        if (token) return { Authorization: `Bearer ${token}` }
      } catch (err) {
        log('app_lifecycle: OIDC access token read failed; continuing without authorization', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return {} as Record<string, string>
    }

    // Desktop always ships all four local sources when settings egress is enabled.
    // No shipping matrix needed: the desktop is the sole shipper for these files
    // in this deployment; the engine is configured separately via engine.json.
    configureEgress(cfg, oidcHeaderProvider, { shipOwnRecords: true, source: 'settings' })
    getSignedInIdentity().then((identity) => {
      if (identity) setEgressUser(identity.user)
    }).catch((err) => log("app_lifecycle: egress user identity read failed", { error: String(err) }))
    startEgressTailers(['desktop', 'engine', 'ios', 'telemetry'])
    log('app_lifecycle: settings egress configured', { targets })
  } catch (err) {
    log('app_lifecycle: settings egress config read failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
