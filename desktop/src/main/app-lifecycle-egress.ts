/**
 * Desktop log-egress bootstrap, split out of `app-lifecycle.ts` to keep that
 * file under the size cap. Two independent sources can turn egress on: the
 * merged engine.json (which enterprise policy may seal) and the operator's
 * own settings.json. Both are complete no-ops when their logging block is
 * absent, so a default install ships nothing.
 */

import { existsSync, readFileSync } from 'fs'
import { app } from 'electron'
import { log as _log } from './logger'
import { engineConfigFile, readSettings } from '@ion/server/persistence/settings-store'
import { configureEgress, setEgressUser, type EgressConfig, type AuthHeaderProvider } from '@ion/shared/log-egress'
import { startEgressTailers } from '@ion/shared/log-egress-tailer'
import { broker } from './connections/broker-instance'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'

/** The engine-minted OIDC token for the telemetry scope, through the local server (`entra.accessToken`). */
async function getAccessToken(): Promise<string | null> {
  const result = await broker.sendAction(LOCAL_ENVIRONMENT_ID, 'entra.accessToken', []) as { token: string | null }
  return result.token
}

/** The signed-in operator, if any, through the local server (`entra.identity`). */
async function getSignedInIdentity(): Promise<{ user: string } | null> {
  const result = await broker.sendAction(LOCAL_ENVIRONMENT_ID, 'entra.identity', []) as { identity: { user: string } | null }
  return result.identity
}

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
  if (!existsSync(engineConfigFile())) return
  try {
    const raw = JSON.parse(readFileSync(engineConfigFile(), 'utf-8')) as Record<string, unknown>
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
        ? logging.egressOtel as import('@ion/shared/log-egress').EgressOtelConfig
        : undefined,
    }

    // Shipping-responsibility matrix: the desktop's share is
    // logging.egressClientShipSources. Unset preserves the legacy
    // single-collection-point default (the desktop ships everything).
    //
    // `server` is in that default because before the server was split out of
    // this process its lines WERE desktop lines: leaving it out would quietly
    // drop from a workstation's shipment everything the store, worktrees and
    // the Studio wire now log.
    const rawClientSources = logging.egressClientShipSources
    const clientSources: string[] = Array.isArray(rawClientSources)
      ? (rawClientSources as string[])
      : ['desktop', 'engine', 'server', 'ios', 'telemetry']
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
      process: 'desktop',
      version: app.getVersion(),
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
        ? logging.egressOtel as import('@ion/shared/log-egress').EgressOtelConfig
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

    // Desktop ships every local source when settings egress is enabled. No
    // shipping matrix needed: the desktop is the sole shipper for these files
    // in this deployment; the engine is configured separately via engine.json.
    configureEgress(cfg, oidcHeaderProvider, { shipOwnRecords: true, source: 'settings', process: 'desktop', version: app.getVersion() })
    getSignedInIdentity().then((identity) => {
      if (identity) setEgressUser(identity.user)
    }).catch((err) => log("app_lifecycle: egress user identity read failed", { error: String(err) }))
    startEgressTailers(['desktop', 'engine', 'server', 'ios', 'telemetry'])
    log('app_lifecycle: settings egress configured', { targets })
  } catch (err) {
    log('app_lifecycle: settings egress config read failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
