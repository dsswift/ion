import { remoteTabStatusFromEngineFields } from './event-wiring-status'
import { lastForwardedTabStatus } from '../state'
import { log } from '../logger'
import { sendRemoteEvent, remoteClientsPresent } from '../thin-view/remote-out'

/**
 * Forward the engine's exact status verdict to iOS for engine-view tabs, which
 * do not route through EngineControlPlane's normal tab-status transition.
 */
export function forwardRemoteEngineStatus(
  tabId: string,
  instanceId: string | null | undefined,
  fields: {
    state?: string
    hasPendingWork?: boolean
    backgroundAgents?: number
    backgroundShells?: number
    permissionDenials?: Array<{ toolName: string }>
  } | null | undefined,
): void {
  if (!fields?.state || !instanceId || !remoteClientsPresent()) return

  const status = remoteTabStatusFromEngineFields(fields)
  if (!status || lastForwardedTabStatus.get(tabId) === status) return
  lastForwardedTabStatus.set(tabId, status)
  log('main', 'engine_status: synthesizing tab_status for remote', {
    tab_id: tabId,
    instance: instanceId,
    derived_status: status,
  })
  if (!remoteClientsPresent()) return
  sendRemoteEvent({ type: 'desktop_tab_status', tabId, status })
}
