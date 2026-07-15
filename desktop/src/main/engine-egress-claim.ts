/**
 * engine-egress-claim.ts — desktop claims engine-log egress for itself.
 *
 * The single-collection-point model (docs/enterprise/central-log-collection.md):
 * when logging.egressTargets is set, the desktop is the machine's collection
 * point. It tails engine.jsonl and ships every engine line on the engine's
 * behalf under its own (OIDC-authenticated) forwarder. If the engine ALSO ran
 * its own forwarder off the same egressTargets flag, every engine log line would
 * ship twice — once unauthenticated by the engine (→ 401 → the
 * ~/.ion/.engine-egress-spool.jsonl balloon) and once authenticated by the
 * desktop.
 *
 * Setting logging.egressManagedByClient=true in engine.json tells the daemon to
 * suppress its OWN forwarder (the engine reads this once at process start). A
 * headless/CI/Docker engine with no desktop never runs this path, so its own
 * forwarder keeps shipping — the flag defaults to false there.
 */

import { existsSync } from 'fs'
import { log as _log } from './logger'
import { ENGINE_CONFIG_FILE, readEngineConfig, writeEngineConfig } from './settings-store'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

/**
 * Stamp logging.egressManagedByClient=true into engine.json when egress is
 * configured, so the engine suppresses its own forwarder and the desktop is the
 * sole shipper of engine lines.
 *
 * Call BEFORE ensureEngineDaemon() so that if this launch brings up a fresh
 * daemon (first install, or a prior Quit All), that daemon already honors the
 * flag on its first read.
 *
 * Idempotent: writes only when egress is configured AND the flag is not already
 * true, so it never churns engine.json once set (churn would force an
 * unnecessary daemon restart). Returns true when it wrote, false otherwise
 * (exposed for tests and callers that want to know whether a write happened).
 */
export function claimEngineEgressForDesktop(): boolean {
  if (!existsSync(ENGINE_CONFIG_FILE)) return false
  try {
    const cfg = readEngineConfig()
    const logging = cfg.logging as Record<string, unknown> | undefined
    if (!logging) return false
    const targets = logging.egressTargets as string[] | undefined
    if (!Array.isArray(targets) || targets.length === 0) return false
    // An explicit shipping-responsibility matrix governs who ships what;
    // the legacy claim boolean must not fight it. The operator/enterprise
    // decided — the desktop honors egressClientShipSources and the engine
    // honors egressShipSources.
    if (logging.egressShipSources !== undefined || logging.egressClientShipSources !== undefined) {
      log('engine_egress_claim: explicit shipping matrix present; legacy claim skipped')
      return false
    }
    if (logging.egressManagedByClient === true) return false // already claimed — no churn

    logging.egressManagedByClient = true
    cfg.logging = logging
    writeEngineConfig(cfg)
    log('engine_egress_claim: claimed engine egress for desktop (egressManagedByClient=true)', { targets })
    return true
  } catch (err) {
    log('engine_egress_claim: claim failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
