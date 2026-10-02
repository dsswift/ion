/**
 * This desktop's device policy: the local Environment's enterprise policy, as
 * last announced. Device policy governs this machine and comes from nowhere
 * else, so only the local Environment's frames are read.
 *
 * Before the local server has answered, the policy is the one its last
 * welcome carried (`env-cache`), so a seal holds from the first read of a
 * launch and not only once the wire is up.
 */
import type { EnterprisePolicy } from '@ion/shared/types-enterprise'
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { readEnvCache } from './env-cache'
import { log as _log } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('device-policy', msg, fields)
}

let live: { policy: EnterprisePolicy | null } | null = null

/** Record the policy a local-Environment frame carries. Other frames, and other Environments, are ignored. */
export function noteDevicePolicyFrame(environmentId: string, frame: StudioFrame): void {
  if (environmentId !== LOCAL_ENVIRONMENT_ID) return
  if (frame.type !== 'studio_welcome' && frame.type !== 'studio_environment_policy') return
  live = { policy: frame.enterprisePolicy }
  log('device policy updated', { frame_type: frame.type, has_policy: frame.enterprisePolicy !== null })
}

export function devicePolicy(): EnterprisePolicy | null {
  if (live) return live.policy
  const welcome = readEnvCache(LOCAL_ENVIRONMENT_ID)?.welcome
  return welcome && welcome.type === 'studio_welcome' ? welcome.enterprisePolicy : null
}

/** Test seam. */
export function _resetDevicePolicyForTest(): void {
  live = null
}
