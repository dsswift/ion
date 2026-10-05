/**
 * fleet/actions — the `fleet.*` `studio_action`s. A client shows every
 * server it is paired with on one Fleet screen by asking each for its
 * report and adding them up; nothing here knows about any other server.
 *
 * The report and the refresh are `conversations:read`: the report holds
 * what the server's own settings pages already show that scope, and
 * refreshing only re-reads. The `fleet.hubs.*` actions are in `hub-actions`,
 * the `fleet.deploy*` ones in `deploy-actions`.
 */
import type { EnvironmentActionSpec } from '../environment/actions'
import { pollAccountsNow } from './account-poll'
import { buildFleetReport, deviceCountsFor } from './report'
import { FLEET_HUB_ACTIONS } from './hub-actions'
import { FLEET_DEPLOY_ACTIONS } from './deploy-actions'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('fleet.actions', msg, fields)
}

export const FLEET_ACTIONS: Record<string, EnvironmentActionSpec> = {
  'fleet.report': {
    requiredScope: 'conversations:read',
    handler: async (conn) => {
      const report = await buildFleetReport(deviceCountsFor(conn))
      log('fleet report built', { connection_id: conn.id, provider_count: report.providers.length, account_count: report.accounts.length, has_metrics: report.metrics !== null })
      return { ok: true, value: report }
    },
  },
  'fleet.refreshAccounts': {
    requiredScope: 'conversations:read',
    handler: async (conn) => {
      const accounts = await pollAccountsNow()
      log('fleet accounts refreshed', { connection_id: conn.id, account_count: accounts.length })
      return { ok: true, value: { accounts } }
    },
  },
  ...FLEET_HUB_ACTIONS,
  ...FLEET_DEPLOY_ACTIONS,
}
