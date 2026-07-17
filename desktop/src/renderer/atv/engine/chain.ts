/**
 * chain — derive the dispatch chain (ancestors + descendants) of an agent
 * from an agent-state snapshot, for the focus-mode highlight. Pure.
 */
import type { AgentStateUpdate } from '../../../shared/types'
import { getDispatches, meta } from '../../lib/agent-helpers'

export function dispatchChainOf(agents: readonly AgentStateUpdate[], name: string): Set<string> {
  const chain = new Set<string>([name])
  const byName = new Map(agents.map((a) => [a.name, a]))
  // Owner lookup: dispatch id → agent that issued it.
  const ownerOfDispatch = new Map<string, string>()
  for (const a of agents) {
    for (const d of getDispatches(a)) ownerOfDispatch.set(d.id, a.name)
  }
  // Ancestors: walk parent dispatch ids upward (bounded against cycles).
  let current = byName.get(name)
  for (let hops = 0; current && hops < 10; hops++) {
    const parentId = meta<string>(current, 'dispatchParentId', '')
    const owner = parentId ? ownerOfDispatch.get(parentId) : undefined
    if (!owner || chain.has(owner)) break
    chain.add(owner)
    current = byName.get(owner)
  }
  // Descendants: BFS over dispatches issued by chain members.
  const queue = [...chain]
  while (queue.length > 0) {
    const memberName = queue.shift()!
    const member = byName.get(memberName)
    if (!member) continue
    const ids = new Set(getDispatches(member).map((d) => d.id))
    for (const a of agents) {
      if (chain.has(a.name)) continue
      const parentId = meta<string>(a, 'dispatchParentId', '')
      if (parentId && ids.has(parentId)) {
        chain.add(a.name)
        queue.push(a.name)
      }
    }
  }
  return chain
}
