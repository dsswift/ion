import type { AgentStateUpdate } from '../../shared/types'
import type { DispatchInfo, DispatchTelemetryEntry } from '../../shared/types-engine'

// Re-export so existing renderer imports keep working.
export type { DispatchInfo }

/** A single frame in the breadcrumb navigation stack. */
export interface BreadcrumbFrame {
  dispatchId: string
  conversationId: string
  agentDisplayName: string
}

/** Read a metadata field with fallback */
export function meta<T>(agent: AgentStateUpdate, key: string, fallback: T): T {
  const val = agent.metadata?.[key]
  return val != null ? (val as T) : fallback
}

/**
 * Extract the structured dispatches array from agent metadata.
 * `dispatches[]` is the single source of truth — no fallback to
 * legacy `conversationId` / `conversationIds` metadata fields.
 */
export function getDispatches(agent: AgentStateUpdate): DispatchInfo[] {
  const raw = agent.metadata?.dispatches
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map((d: any) => ({
      id: String(d.id ?? ''),
      task: String(d.task ?? ''),
      model: String(d.model ?? ''),
      conversationId: String(d.conversationId ?? ''),
      elapsed: typeof d.elapsed === 'number' ? d.elapsed : undefined,
      status: String(d.status ?? ''),
      startTime: typeof d.startTime === 'number' ? d.startTime : undefined,
    }))
  }
  return []
}

/**
 * Find a dispatch by id across ALL agent-state pills. This is the DURABLE
 * per-dispatch lookup: pills are re-emitted on every `engine_agent_state`
 * heartbeat snapshot and carry the dispatch's own model / task /
 * conversationId / startTime, so the lookup succeeds even when the one-shot
 * `dispatchTelemetry` stream was never observed (late attach / tab reopen).
 * Returns undefined when no pill owns the id.
 */
export function findDispatchById(
  agents: AgentStateUpdate[],
  dispatchId: string,
): DispatchInfo | undefined {
  if (!dispatchId) return undefined
  for (const agent of agents) {
    const match = getDispatches(agent).find((d) => d.id === dispatchId)
    if (match) return match
  }
  return undefined
}

/**
 * Convert a flat DispatchTelemetryEntry (from engine_dispatch_start/end) into
 * the DispatchInfo shape the header chrome and dispatch rows render. Status is
 * derived from exitCode presence: undefined means the dispatch_end has not
 * arrived yet, so the dispatch is still running.
 */
export function telemetryToDispatchInfo(entry: DispatchTelemetryEntry): DispatchInfo {
  return {
    id: entry.dispatchId,
    task: entry.dispatchTask,
    model: entry.dispatchModel,
    conversationId: entry.conversationId ?? '',
    elapsed: entry.elapsed,
    status: entry.exitCode !== undefined ? (entry.exitCode === 0 ? 'done' : 'error') : 'running',
  }
}

/**
 * The stable key under which per-agent UI state (expand/select/popup) is stored
 * in AgentPanel. Uses the MOST RECENT dispatch's id so two dispatches of the
 * same agent name remain distinct rows with independent state. Falls back to
 * the agent name for agents with no dispatch (extension-roster rows, pre-fix
 * persisted state).
 */
export function dispatchKey(agent: AgentStateUpdate): string {
  return mostRecentDispatch(getDispatches(agent))?.id ?? agent.name
}

export const AGENT_COLORS: Record<string, string> = {
  'cloud-architect': '#b4325a',
  'security-officer': '#c88c1e',
  'chief-admin': '#b43232',
  'reliability-engineer': '#32b464',
  'infra-engineer': '#3c96d2',
  'dev-lead': '#8c5ac8',
  'press-secretary': '#8c3cb4',
  'secret-service': '#505050',
  'chief': '#1e3278',
  'specialist': '#144b55',
  'staff': '#411e64',
  'consultant': '#5a410f',
}

function hashColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) - hash) + str.charCodeAt(i)
  const h = Math.abs(hash) % 360
  return `hsl(${h}, 45%, 35%)`
}

export function getAgentColor(agent: AgentStateUpdate): string {
  const color = meta(agent, 'color', '')
  if (color) return color
  if (AGENT_COLORS[agent.name]) return AGENT_COLORS[agent.name]
  return hashColor(meta(agent, 'type', agent.name))
}

/**
 * Whether an agent is a root-level dispatch (a direct child of the
 * orchestrator) versus a nested dispatch (a specialist dispatched by another
 * dispatched agent). The main conversation panel shows only root-level agents
 * so a lead's specialists appear inside the lead's dispatch preview, not the
 * main conversation row.
 *
 * Attribution is stamped onto the agent-state metadata at dispatch time
 * (dispatch_agent.go): `dispatchDepth` (1=direct child, 2=grandchild, ...) and
 * `dispatchParentId` (the parent dispatch's id; empty for orchestrator-direct
 * dispatches). Back-compat: extension-roster pills and pre-fix persisted state
 * carry no attribution (depth 0, empty parent) and are treated as root-level.
 */
export function isRootLevelAgent(agent: AgentStateUpdate): boolean {
  const depth = meta<number>(agent, 'dispatchDepth', 0)
  const parentId = meta<string>(agent, 'dispatchParentId', '')
  return depth <= 1 || parentId === ''
}

export function isAgentVisible(agent: AgentStateUpdate): boolean {
  const visibility = meta<string>(agent, 'visibility', 'ephemeral')
  switch (visibility) {
    case 'always': return true
    case 'sticky': return meta(agent, 'invited', false)
    case 'ephemeral': return agent.status === 'running'
    default: return agent.status === 'running'
  }
}

export function sortAgents(agents: AgentStateUpdate[]): AgentStateUpdate[] {
  const statusOrder: Record<string, number> = { running: 0, done: 1, error: 1, cancelled: 1, idle: 2 }
  const visOrder: Record<string, number> = { always: 0, sticky: 1, ephemeral: 2 }
  return [...agents].sort((a, b) => {
    const sa = statusOrder[a.status] ?? 2
    const sb = statusOrder[b.status] ?? 2
    if (sa !== sb) return sa - sb
    const va = visOrder[meta(a, 'visibility', 'ephemeral')] ?? 9
    const vb = visOrder[meta(b, 'visibility', 'ephemeral')] ?? 9
    if (va !== vb) return va - vb
    return meta(a, 'displayName', a.name).localeCompare(meta(b, 'displayName', b.name))
  })
}

/**
 * The subset of theme tokens `getStatusDot` reads. Declared structurally so this
 * pure helper stays free of any theme-store import; `AgentPanel` passes the live
 * `useColors()` object, which satisfies this shape.
 */
export interface StatusDotColors {
  statusRunning: string
  statusWaitingChildren: string
  statusWaitingChildrenGlow: string
  statusComplete: string
  statusError: string
  statusIdle: string
}

/** The resolved dot attributes for one agent row. `glowColor` is empty when the
 *  dot carries no glow (only the yellow "waiting on children" state glows,
 *  mirroring the platform's tab/status-bar dots). */
export interface StatusDot {
  bg: string
  pulse: boolean
  glowColor: string
}

/**
 * A `StatusDot` plus its rank, so an aggregate over several dispatches can pick
 * the most important state to show (higher wins) the way
 * `getGroupStatusColor` folds a group of tabs down to one dot.
 *
 * Deliberately a SEPARATE type rather than a field on `StatusDot`: `getStatusDot`
 * is consumed by callers that compare its result exactly, so widening the base
 * shape would change a published contract for every one of them. The rank is
 * additive surface for the folds that need it.
 */
export interface RankedStatusDot extends StatusDot {
  priority: number
}

/**
 * Statuses that mean "this agent is alive", as opposed to terminal.
 *
 * `suspended` is the engine's park state (dispatch_agent.go sets it when a
 * dispatch waits on its children or a revive; agents/registry.go ranks it above
 * the terminal states). A parked agent has NOT finished, so every liveness
 * question in this module — descendant walks, active counts — must treat it the
 * same as `running`. Losing this distinction is how a live tree once rendered
 * as fully complete.
 */
export function isLiveStatus(status: string): boolean {
  return status === 'running' || status === 'suspended'
}

/**
 * Resolve the dot attributes for one status, given whether a live descendant
 * hangs off the dispatch being described.
 *
 * This is the single cascade; `getStatusDot` delegates to it. Order matters:
 *
 *   error                          → solid statusError
 *   live descendant, or suspended  → pulsing statusWaitingChildren + glow
 *   running                        → pulsing statusRunning
 *   done                           → solid statusComplete
 *   else (idle / cancelled / …)    → solid statusIdle
 *
 * The descendant check sits ABOVE the terminal branches on purpose: a parent
 * marked done while a child still runs must read as waiting-on-children, never
 * as a finished green dot, because the tree is not finished.
 */
export function resolveDotForStatus(
  status: string,
  colors: StatusDotColors,
  hasLiveDescendant: boolean,
): RankedStatusDot {
  if (status === 'error') {
    return { bg: colors.statusError, pulse: false, glowColor: '', priority: 4 }
  }
  if (hasLiveDescendant || status === 'suspended') {
    return { bg: colors.statusWaitingChildren, pulse: true, glowColor: colors.statusWaitingChildrenGlow, priority: 3 }
  }
  if (status === 'running') {
    return { bg: colors.statusRunning, pulse: true, glowColor: '', priority: 2 }
  }
  if (status === 'done') {
    return { bg: colors.statusComplete, pulse: false, glowColor: '', priority: 1 }
  }
  return { bg: colors.statusIdle, pulse: false, glowColor: '', priority: 0 }
}

/**
 * Whether any agent anywhere BELOW the given dispatch is still alive.
 *
 * Walks the dispatch tree breadth-first: children of `dispatchId` are the
 * agents whose `dispatchParentId` metadata names it, and each of those agents'
 * own dispatch ids are queued in turn, so a depth-3+ descendant counts just as
 * a direct child does. Matching on the dispatch ID (not the agent name) is what
 * makes this precise — a grouped agent row spans several dispatches, and only
 * the id says which one owns a given descendant.
 *
 * `visited` guards against a cycle in the parent attribution, which would
 * otherwise spin forever on malformed metadata.
 */
export function hasLiveDescendantOfDispatch(
  allAgents: AgentStateUpdate[],
  dispatchId: string,
): boolean {
  if (!dispatchId) return false
  const queue: string[] = [dispatchId]
  const visited = new Set<string>()
  while (queue.length > 0) {
    const current = queue.shift()!
    if (!current || visited.has(current)) continue
    visited.add(current)
    for (const child of childAgentsOf(allAgents, current)) {
      if (isLiveStatus(child.status)) return true
      for (const d of getDispatches(child)) queue.push(d.id)
    }
  }
  return false
}

/**
 * The agent's most recent dispatch, by START TIME rather than array position.
 *
 * The engine merges an agent's dispatches in slot-insertion order and
 * de-duplicates them by id (agents/registry.go), so the array is only
 * incidentally chronological — trusting `.at(-1)` would silently pick the wrong
 * one after a persist/rehydrate round-trip. Members with no `startTime` (legacy
 * or rehydrated rows) fall back to their array position, so a list without any
 * timestamps still resolves to its last entry.
 */
export function mostRecentDispatch(dispatches: DispatchInfo[]): DispatchInfo | undefined {
  if (dispatches.length === 0) return undefined
  let best = dispatches[0]
  let bestIdx = 0
  for (let i = 1; i < dispatches.length; i++) {
    const candidate = dispatches[i]
    const candidateTime = candidate.startTime
    const bestTime = best.startTime
    if (candidateTime == null && bestTime == null) {
      // Neither is timestamped — later position wins.
      best = candidate
      bestIdx = i
      continue
    }
    if (candidateTime == null) continue
    if (bestTime == null || candidateTime > bestTime || (candidateTime === bestTime && i > bestIdx)) {
      best = candidate
      bestIdx = i
    }
  }
  return best
}

/**
 * Whether an agent counts as ACTIVE for the panel header's breakdown.
 *
 * True when the agent itself is live, or when any of its dispatches still owns
 * a live descendant. The second clause is what keeps the header honest with the
 * row dots: a lead whose own dispatches all finished, but one of whose older
 * dispatches still has a specialist working, is not "done".
 */
export function isAgentActive(agent: AgentStateUpdate, allAgents: AgentStateUpdate[]): boolean {
  if (isLiveStatus(agent.status)) return true
  return getDispatches(agent).some((d) => hasLiveDescendantOfDispatch(allAgents, d.id))
}

/**
 * Map an agent's status to the platform's standardized status-dot vocabulary,
 * the same cascade `StatusDot` (TabStripStatusDot.tsx) and the status bar use.
 *
 * Thin delegator to `resolveDotForStatus` — that function documents and owns
 * the cascade, so there is exactly ONE place the ordering lives and no way for
 * a second copy to drift from it. Kept pure: the caller resolves `colors` from
 * `useColors()` and the child-liveness flag from `childAgentsOf` (direct
 * children) or `hasLiveDescendantOfDispatch` (the whole subtree).
 */
export function getStatusDot(
  agent: AgentStateUpdate,
  colors: StatusDotColors,
  hasRunningChildren: boolean,
): StatusDot {
  // Drop `priority` so this function's published shape is unchanged: callers
  // compare the result exactly, and the rank is only meaningful to the folds.
  const { bg, pulse, glowColor } = resolveDotForStatus(agent.status, colors, hasRunningChildren)
  return { bg, pulse, glowColor }
}

export function formatDuration(secs: number): string {
  if (secs < 60) return `${secs}s`
  if (secs < 3600) {
    const m = Math.floor(secs / 60)
    const s = secs % 60
    return `${m}m ${s}s`
  }
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return `${h}h ${m}m`
}

/**
 * Derive the dispatch nesting depth for each dispatch from flat telemetry
 * entries. Returns a Map from dispatchId to its dispatch depth (0 = root).
 * Keyed by dispatchId (unique per dispatch instance) so two dispatches of the
 * same agent name do not collapse onto one another — AgentPanel looks up each
 * agent's own dispatch id, not its name, to indent nested dispatches.
 */
export function selectAgentDepths(telemetry: DispatchTelemetryEntry[]): Map<string, number> {
  const depths = new Map<string, number>()
  for (const entry of telemetry) {
    depths.set(entry.dispatchId, entry.dispatchDepth)
  }
  return depths
}

/**
 * Return direct children of a given dispatch, keyed by dispatchId.
 * A child is any entry whose dispatchParentId equals the given dispatchId.
 */
export function childrenOfDispatch(
  telemetry: DispatchTelemetryEntry[],
  dispatchId: string,
): DispatchTelemetryEntry[] {
  return telemetry.filter((e) => e.dispatchParentId === dispatchId)
}

/**
 * Return the agent-state pills that are direct children of a given dispatch:
 * any agent whose `dispatchParentId` metadata equals `parentDispatchId`.
 *
 * This is the DURABLE counterpart to `childrenOfDispatch` (which filters the
 * one-shot `dispatchTelemetry` stream). Agent-state pills carry the same
 * nesting attribution (`dispatchParentId`, `dispatchDepth`, `dispatches[]`)
 * and are re-emitted on every `engine_agent_state` heartbeat snapshot, so a
 * consumer that attaches AFTER a dispatch completed (or reopens the tab) can
 * still reconstruct the dispatch tree from them — whereas `dispatchTelemetry`
 * is gone by then. The dispatch-preview panel sources its nested children from
 * here so a child renders regardless of attach timing. An empty
 * `parentDispatchId` matches nothing (root-level pills are not "children").
 */
export function childAgentsOf(
  agents: AgentStateUpdate[],
  parentDispatchId: string,
): AgentStateUpdate[] {
  if (!parentDispatchId) return []
  return agents.filter((a) => meta<string>(a, 'dispatchParentId', '') === parentDispatchId)
}

/**
 * Return root-level dispatches (entries with no parent).
 * Root entries have an empty or missing dispatchParentId.
 */
export function rootDispatches(
  telemetry: DispatchTelemetryEntry[],
): DispatchTelemetryEntry[] {
  return telemetry.filter((e) => !e.dispatchParentId)
}


/**
 * Build the full ancestor breadcrumb stack for a deep-linked dispatch.
 *
 * Walks dispatchParentId up through durable agentStates to produce an ordered
 * chain: root → ... → target. All data is already on agentStates; no network
 * call required.
 *
 * This closes the "missing breadcrumbs on cold open" gap described in plan
 * modest-leaping-waffle.md §7a: AgentDetailPanel.stack initializes with only
 * the root frame (AgentDetailPanel.tsx:75-81); intermediate frames only exist
 * via manual drill-down. Pre-populating with this function lets deep-links from
 * the StatusDrawer arrive at the correct tier without the user drilling down.
 *
 * @param targetDispatchId  - The dispatch the user clicked in the Status Drawer.
 * @param allAgents         - Flat agentStates from the active instance.
 * @returns Ordered BreadcrumbFrame[] (root first, target last), or null if the
 *          target dispatch cannot be found in agentStates.
 */
export function buildBreadcrumbStack(
  targetDispatchId: string,
  allAgents: AgentStateUpdate[],
): BreadcrumbFrame[] | null {
  // Find the agent that owns this dispatch id
  const findAgent = (dispatchId: string): AgentStateUpdate | undefined =>
    allAgents.find((a) => getDispatches(a).some((d) => d.id === dispatchId))

  const targetAgent = findAgent(targetDispatchId)
  if (!targetAgent) return null

  const targetDispatch = getDispatches(targetAgent).find((d) => d.id === targetDispatchId)
  if (!targetDispatch) return null

  // Build ancestor chain by walking dispatchParentId
  const frames: BreadcrumbFrame[] = []
  let currentDispatchId = targetDispatchId
  let currentAgent: AgentStateUpdate | undefined = targetAgent

  // Walk up to root (max 20 levels to guard infinite loops)
  const visited = new Set<string>()
  while (currentAgent && !visited.has(currentDispatchId)) {
    visited.add(currentDispatchId)
    const dispatch = getDispatches(currentAgent).find((d) => d.id === currentDispatchId)
    if (!dispatch) break
    frames.unshift({
      dispatchId: dispatch.id,
      conversationId: dispatch.conversationId,
      agentDisplayName: meta<string>(currentAgent, 'displayName', currentAgent.name),
    })
    const parentId = meta<string>(currentAgent, 'dispatchParentId', '')
    if (!parentId) break
    currentDispatchId = parentId
    currentAgent = findAgent(parentId)
    // findAgent returns the agent owning the PARENT dispatch id
  }

  return frames.length > 0 ? frames : null
}
