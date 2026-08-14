import type { EngineBridge } from './engine-bridge'
import { handleEngineEvent } from './engine-control-plane-events'
import type { EventEmitterContext, TabEntry } from './engine-control-plane-events-types'
import type { EngineEvent } from '../shared/types'

// installRecoveredAgentStateListener feeds a requester-only full roster back
// through the same control-plane reducer as an ordinary engine snapshot. It is
// local desktop recovery data, never an engine event or iOS fan-out message.
export function makeEventContext(
  bridge: EngineBridge,
  emit: EventEmitterContext['emit'],
  setStatus: EventEmitterContext['setStatus'],
  checkDrain: EventEmitterContext['checkDrain'],
): EventEmitterContext {
  return { bridge, emit, setStatus, checkDrain }
}

export function installRecoveredAgentStateListener(
  bridge: EngineBridge,
  tabs: Map<string, TabEntry>,
  makeContext: () => EventEmitterContext,
): void {
  bridge.on('agent-state-recovered', (key: string, event: EngineEvent) => {
    const tab = tabs.get(key)
    if (!tab) return
    handleEngineEvent(makeContext(), key, tab, event)
  })
}
