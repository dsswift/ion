/**
 * The `fleet.deploy*` `studio_action`s: `ion fleet deploy` on this machine
 * reports its record here, and a client reads the deploys this server holds.
 * Reporting is an admin's: a record is shown to every client and sent to
 * every Fleet Hub the server reports to. `fleet.deploy.source` finds the
 * checkout a deploy on this machine builds from, a bench by its branch.
 */
import { parseFleetDeployRecord } from '@ion/shared/types-fleet-deploy'
import { parseFleetSourceQuery, type FleetCheckout } from '@ion/shared/types-fleet-run'
import type { EnvironmentActionSpec } from '../environment/actions'
import { benchOfFolder, checkoutForBranch } from '../integration/bench-source-checkout'
import { listFleetDeploys, recordFleetDeploy } from './deploy-ledger'
import { log as _log, warn as _warn } from '../logger'
import { withSpan } from '../tracing/op-span'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('fleet.deploy-actions', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('fleet.deploy-actions', msg, fields)
}

export const FLEET_DEPLOY_ACTIONS: Record<string, EnvironmentActionSpec> = {
  'fleet.deploy.report': {
    requiredScope: 'admin',
    handler: async (conn, args) => {
      const record = parseFleetDeployRecord(args[0])
      if (!record) {
        warn('fleet deploy report refused: not a deploy record', { connection_id: conn.id })
        return { ok: false, refusal: { code: 'invalid_deploy', message: 'That is not a deploy record.' } }
      }
      // The deploy's record reaching every client and every hub this server reports to.
      withSpan('fleet.deploy', { attrs: { deploy_id: record.id, state: record.state, target_count: record.targets.length } }, () => recordFleetDeploy(record))
      return { ok: true, value: null }
    },
  },
  'fleet.deploys.list': {
    requiredScope: 'conversations:read',
    handler: async () => ({ ok: true, value: listFleetDeploys() }),
  },
  'fleet.deploy.source': {
    requiredScope: 'conversations:read',
    handler: async (conn, args) => {
      const query = parseFleetSourceQuery(args[0])
      if (!query) {
        warn('fleet deploy source refused: neither a folder nor a bench', { connection_id: conn.id })
        return { ok: false, refusal: { code: 'invalid_source', message: 'Name a folder, or a bench by its repository and branch.' } }
      }
      if (typeof query === 'string') {
        const bench = benchOfFolder(query)
        log('fleet deploy source is a folder', { connection_id: conn.id, folder: query, bench_branch: bench?.branch ?? '' })
        const checkout: FleetCheckout = { path: query, via: 'folder', ...(bench ? { bench } : {}) }
        return { ok: true, value: checkout }
      }
      const found = await checkoutForBranch(query)
      if (!found.ok) return { ok: false, refusal: { code: 'no_checkout', message: found.error } }
      const checkout: FleetCheckout = { path: found.path, via: found.via, bench: query }
      return { ok: true, value: checkout }
    },
  },
}
