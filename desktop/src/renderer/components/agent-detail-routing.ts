import type { AgentStateUpdate } from '../../shared/types'
import type { DispatchInfo } from '../../shared/types-engine'
import { contentRouter } from '../lib/file-open-router'
import { meta, mostRecentDispatch } from './agent-panel-helpers'

export function mostRecentDispatchIndex(dispatches: DispatchInfo[]): number {
  const recent = mostRecentDispatch(dispatches)
  return recent ? dispatches.findIndex((dispatch) => dispatch.id === recent.id) : -1
}

/** Route dispatch detail into Studio. Overlay has no router and keeps its popup. */
export function routeAgentDetailToSurface(
  agent: AgentStateUpdate,
  dispatch: DispatchInfo | undefined,
): boolean {
  const openDispatch = contentRouter()?.openDispatch
  if (!openDispatch || !dispatch?.id) return false
  openDispatch(agent.name, dispatch.id, meta(agent, 'displayName', agent.name))
  return true
}
