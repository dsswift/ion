import type { EngineEvent, AgentStateUpdate } from '../shared/types'
import type { EngineBridge } from './engine-bridge'
import { debug as _debug, warn as _warn } from './logger'

const TAG = 'EngineBridgeAgentState'
function debug(msg: string, fields?: Record<string, unknown>): void { _debug(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Returns a stable bounded-roster fingerprint without retaining oversized values. */
export function agentStateFingerprint(agents: AgentStateUpdate[]): string {
  return agents.map(agent => {
    const metadata = agent.metadata ?? {}
    const keys = Array.isArray(metadata._truncatedKeys) ? metadata._truncatedKeys.join(',') : ''
    return `${agent.name}:${agent.status}:${keys}:${metadata.dispatchesTotal ?? ''}`
  }).join('|')
}

export function rosterNeedsFullRecovery(event: EngineEvent): event is Extract<EngineEvent, { type: 'engine_agent_state' }> {
  return event.type === 'engine_agent_state' && event.agents.some(agent => agent.metadata?._truncated === true || Array.isArray(agent.metadata?._truncatedKeys))
}

export function installAgentStateRecovery(bridge: EngineBridge): void {
  const requested = new Map<string, string>()
  bridge.on('event', (key: string, event: EngineEvent) => {
    if (!rosterNeedsFullRecovery(event)) return
    const fingerprint = agentStateFingerprint(event.agents)
    if (requested.get(key) === fingerprint) return
    requested.set(key, fingerprint)
    void bridge.getAgentState(key).then(result => {
      if (!result.ok || !result.agents) {
        warn('full_agent_state_recovery_failed', { key, error: result.error ?? 'missing roster' })
        return
      }
      debug('full_agent_state_recovered', { key, agents: result.agents.length })
      bridge.emit('agent-state-recovered', key, { type: 'engine_agent_state', agents: result.agents } as EngineEvent)
    }).catch(err => {
      warn('full_agent_state_recovery_failed', { key, error: String(err) })
    })
  })
}
