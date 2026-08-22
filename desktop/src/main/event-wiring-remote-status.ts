import { remoteTabStatusFromEngineFields } from './event-wiring-status'
import { state, lastForwardedTabStatus } from './state'
import { log } from './logger'

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
  if (!fields?.state || !instanceId || !state.remoteTransport) return

  const status = remoteTabStatusFromEngineFields(fields)
  if (!status || lastForwardedTabStatus.get(tabId) === status) return
  lastForwardedTabStatus.set(tabId, status)
  log('main', 'engine_status: synthesizing tab_status for remote', {
    tab_id: tabId,
    instance: instanceId,
    derived_status: status,
  })
  if (!state.remoteTransport) return
  state.remoteTransport.send({ type: 'desktop_tab_status', tabId, status })
}
