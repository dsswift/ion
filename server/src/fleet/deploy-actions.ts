/**
 * The `fleet.deploy*` `studio_action`s: `ion fleet deploy` on this machine
 * reports its record here, and a client reads the deploys this server holds.
 * Reporting is an admin's: a record is shown to every client and sent to
 * every Fleet Hub the server reports to.
 */
import { parseFleetDeployRecord } from '@ion/shared/types-fleet-deploy'
import type { EnvironmentActionSpec } from '../environment/actions'
import { listFleetDeploys, recordFleetDeploy } from './deploy-ledger'
import { warn as _warn } from '../logger'

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
      recordFleetDeploy(record)
      return { ok: true, value: null }
    },
  },
  'fleet.deploys.list': {
    requiredScope: 'conversations:read',
    handler: async () => ({ ok: true, value: listFleetDeploys() }),
  },
}
