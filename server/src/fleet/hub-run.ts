/**
 * What this server does for each action a hub may ask for, and the wiring
 * that starts its hub links at boot. A hub is nobody's device, so its
 * actions run here by name rather than through a client connection.
 */
import type { HubAction } from '@ion/shared/fleet-hub'
import type { EnvironmentActionOutcome } from '../environment/actions'
import { requestHostInstall } from '../environment/host-install'
import { currentServerConfig } from '../config/current'
import { resolveSecretRef } from '../config/secret-ref'
import { currentEnvironmentId } from '../identity/environment-id'
import { currentEnterprisePolicy } from '../enterprise-policy-source'
import { onEnterprisePolicyChange, settledEnterprisePolicy } from '../enterprise-policy-publish'
import { dataDir } from '../paths'
import { pollAccountsNow } from './account-poll'
import { buildFleetReport, hostDeviceCounts } from './report'
import { FleetHubLinks, setFleetHubLinks } from './hub-links'
import type { HubActionOutcome } from './hub-link'
import { FleetHubStore } from './hub-store'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('fleet.hub-run', msg, fields)
}

function str(args: unknown[], key: string): string | undefined {
  const first = args[0]
  const value = first && typeof first === 'object' ? (first as Record<string, unknown>)[key] : undefined
  return typeof value === 'string' && value ? value : undefined
}

const RUN: Record<HubAction, (args: unknown[]) => Promise<EnvironmentActionOutcome>> = {
  'fleet.refreshAccounts': async () => ({ ok: true, value: { accounts: await pollAccountsNow() } }),
  'environment.server.restart': async () => requestHostInstall({ kind: 'restart' }),
  'environment.server.update': async (args) => requestHostInstall({ kind: 'release', version: str(args, 'version') }),
}

export async function runHubAction(action: HubAction, args: unknown[]): Promise<HubActionOutcome> {
  const outcome = await RUN[action](args)
  if (outcome.ok) return { ok: true, value: outcome.value }
  const why = 'error' in outcome ? outcome.error : outcome.refusal
  return { ok: false, error: why?.message ?? 'the server refused' }
}

/** Starts this server's hub links and keeps them in line with the enterprise policy. Returns the stop function. */
export function startFleetHubs(): () => void {
  const dir = dataDir()
  const config = currentServerConfig()
  const links = new FleetHubLinks({
    store: new FleetHubStore(dir),
    policy: currentEnterprisePolicy,
    resolveSecret: (ref) => resolveSecretRef(ref, dir),
    environmentId: () => currentEnvironmentId() ?? '',
    label: config.label,
    reportSeconds: config.fleet.hubReportSeconds,
    buildReport: () => buildFleetReport(hostDeviceCounts()),
    runAction: runHubAction,
  })
  setFleetHubLinks(links)
  links.reconcile()
  const unsubscribe = onEnterprisePolicyChange(() => links.reconcile())
  // The first read of the policy settles without telling subscribers, and it
  // can land after the reconcile above. A hub the policy names is joined
  // once that read is in.
  let stopped = false
  void settledEnterprisePolicy().then((policy) => {
    if (stopped) return
    log('fleet hubs reconciled after the first policy read', { has_policy: policy !== null })
    links.reconcile()
  })
  log('fleet hubs started', { report_seconds: config.fleet.hubReportSeconds })
  return () => {
    stopped = true
    unsubscribe()
    links.close()
    setFleetHubLinks(null)
    log('fleet hubs stopped')
  }
}
