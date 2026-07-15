import { useEffect, useRef } from 'react'
import type { AgentStateUpdate } from '../../shared/types'
import { getDispatches, isRootLevelAgent, meta } from '../lib/agent-helpers'

/**
 * Click-to-inspect bridge from the Agent Team Visualizer: the ATV window
 * forwards an agent selection through the main process, App.tsx re-dispatches
 * it as an `ion:open-agent-detail` CustomEvent, and this hook opens the named
 * agent's detail exactly as if its AgentPanel row was clicked.
 *
 * Nested specialists are not root-level rows, so the floating detail panel
 * cannot target them directly — their dispatches live inside their lead's
 * panel. Clicking one resolves UP the dispatch chain (dispatchParentId →
 * owning agent) to the root-level lead and opens that panel, where the
 * specialist's dispatch preview is one drill-down away.
 *
 * Stable-ref pattern: `agents` and `toggleAgent` are held in refs so the
 * event listener is registered exactly once on mount and reads the latest
 * values on each invocation. Without this, the missing dep array would
 * re-register the listener on every render — during streaming, that is once
 * per text chunk — causing runaway listener accumulation.
 */
export function useAgentDetailOpener(
  agents: AgentStateUpdate[],
  toggleAgent: (name: string, agent: AgentStateUpdate) => void,
): void {
  const agentsRef = useRef(agents)
  const toggleRef = useRef(toggleAgent)
  // Keep refs in sync with the latest values on every render without
  // triggering the effect.
  agentsRef.current = agents
  toggleRef.current = toggleAgent

  useEffect(() => {
    const onOpenDetail = (e: Event) => {
      const agentName = (e as CustomEvent<{ agentName: string }>).detail?.agentName
      if (!agentName) return
      const currentAgents = agentsRef.current
      let agent = currentAgents.find((a) => a.name === agentName)
      // Walk to the root-level owner (bounded against attribution cycles).
      for (let hop = 0; agent && !isRootLevelAgent(agent) && hop < 10; hop++) {
        const parentId = meta<string>(agent, 'dispatchParentId', '')
        const owner = currentAgents.find((a) => getDispatches(a).some((d) => d.id === parentId))
        if (!owner) break
        agent = owner
      }
      if (agent) toggleRef.current(agent.name, agent)
    }
    window.addEventListener('ion:open-agent-detail', onOpenDetail)
    return () => window.removeEventListener('ion:open-agent-detail', onOpenDetail)
  }, []) // Stable: listener registered once, reads latest values via refs
}
