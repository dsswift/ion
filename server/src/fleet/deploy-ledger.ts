/**
 * The deploys this server was told of (`fleet.deploy.report`), newest first.
 * `ion fleet deploy` on this machine sends its record at every step; the
 * ledger keeps the newest few in memory, and every change reaches Studio on
 * `ion:fleet-deploys` and each Fleet Hub the server reports to. A deploy is
 * its own process's to remember: one still running when this server restarts
 * arrives again with its next step.
 */
import { FLEET_DEPLOYS_CHANNEL, mergeFleetDeploy, type FleetDeploy, type FleetDeployRecord } from '@ion/shared/types-fleet-deploy'
import { broadcast } from '../broadcast'
import { fleetHubLinks } from './hub-links'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('fleet.deploy-ledger', msg, fields)
}

let deploys: FleetDeploy[] = []

/** Every deploy held, newest first. */
export function listFleetDeploys(): FleetDeploy[] {
  return deploys
}

/** Takes a deploy's newest record, publishes the list, and passes the record to the hubs. */
export function recordFleetDeploy(record: FleetDeployRecord, now: number = Date.now()): FleetDeploy[] {
  const known = deploys.some((d) => d.id === record.id)
  deploys = mergeFleetDeploy(deploys, { ...record, receivedAt: now })
  // A step is frequent; a deploy starting or ending is what the log is for.
  if (!known || record.state !== 'running') log('fleet deploy recorded', { deploy_id: record.id, state: record.state, target_count: record.targets.length, known })
  broadcast(FLEET_DEPLOYS_CHANNEL, deploys)
  fleetHubLinks()?.deploy(record)
  return deploys
}

/** TEST ONLY. */
export function _resetFleetDeploysForTest(): void {
  deploys = []
}
