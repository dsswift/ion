/**
 * Live-state mapping: agent-state snapshots + cross-cutting events →
 * visualization intents. Pure and headless-testable — OfficeState consumes
 * the intents; this module never touches entities or the canvas.
 *
 * Delivery animations have two sources, belt and suspenders:
 *
 *   PRIMARY — `dispatch_start` events. The engine emits dispatch telemetry
 *   for EVERY depth on the conversation's root session stream (the dispatch
 *   chain threads the root session accessor down through nested spawners),
 *   so the event is the precise dispatch moment with its dispatchId.
 *
 *   BACKSTOP — agent-state snapshot transitions. Snapshots are the durable
 *   replayed surface; an agent flipping to `running` is the same dispatch
 *   moment at heartbeat granularity. If an event is ever missed (window
 *   opened mid-flight, transient drop), the snapshot still animates it.
 *
 *   OfficeState dedupes the two (per-recipient delivery cooldown) so a
 *   dispatch observed on both surfaces walks the courier once.
 *
 * The signal table:
 *
 *   dispatch_start (root/nested)     → manager / owning lead delivers
 *   agent newly running              → delivery backstop + works at desk
 *   agent running (first paint)      → seated working, no delivery replay
 *   done                             → stretch, then break room
 *   error                            → red bubble + slump
 *   idle                             → recover, mill about
 *   status.state running             → the ORCHESTRATOR is thinking: the
 *                                      manager works at his desk (and any
 *                                      permission bubble clears)
 *   status.state idle                → manager stands down
 *   permission_request               → amber bubble on the manager
 *   dispatch_activity (tool_*)       → per-agent activity (tooltip text +
 *                                      typing/reading flavor)
 */
import type { NormalizedEvent } from '../../../shared/types'
import type { AgentStateUpdate } from '../../../shared/types'
import { getDispatches, meta } from '../../lib/agent-helpers'

export type Intent =
  | { kind: 'agent-working'; agent: string }
  | { kind: 'agent-done'; agent: string }
  | { kind: 'agent-error'; agent: string }
  | { kind: 'agent-idle'; agent: string }
  | { kind: 'agent-activity'; agent: string; toolName: string | null }
  | { kind: 'deliver'; from: 'manager' | string; toAgent: string }
  | { kind: 'manager-working' }
  | { kind: 'manager-idle' }
  | { kind: 'permission-wait'; bubble: 'permission' | 'plan' | 'question' }
  | { kind: 'permission-clear' }

/**
 * Find which agent owns a dispatch id (the lead that hand-delivers a nested
 * dispatch). Undefined when the owner is not in the snapshot.
 */
export function ownerOfDispatch(agents: AgentStateUpdate[], dispatchId: string): string | undefined {
  return agents.find((a) => getDispatches(a).some((d) => d.id === dispatchId))?.name
}

/**
 * Diff two agent-state snapshots into intents.
 *
 * Emits only on status CHANGE (or first sight of an agent) — snapshots
 * re-emit continuously on the extension heartbeat, and repeating "working"
 * every tick would reset animations.
 *
 * `initial` marks a scene (re)build from a snapshot with no history: agents
 * already running are placed at their desks working, but no delivery
 * animation replays (the dispatch moment already passed).
 */
export function diffSnapshots(
  prev: AgentStateUpdate[],
  next: AgentStateUpdate[],
  options: { initial?: boolean } = {},
): Intent[] {
  const prevByName = new Map(prev.map((a) => [a.name, a]))
  const intents: Intent[] = []
  for (const agent of next) {
    const before = prevByName.get(agent.name)
    if (before && before.status === agent.status) continue
    switch (agent.status) {
      case 'running': {
        // The transition INTO running is the dispatch moment: courier walks.
        if (!options.initial) {
          const parentId = meta<string>(agent, 'dispatchParentId', '')
          const owner = parentId ? ownerOfDispatch(next, parentId) : undefined
          intents.push({ kind: 'deliver', from: owner ?? 'manager', toAgent: agent.name })
        }
        intents.push({ kind: 'agent-working', agent: agent.name })
        break
      }
      case 'done':
        intents.push({ kind: 'agent-done', agent: agent.name })
        break
      case 'error':
        intents.push({ kind: 'agent-error', agent: agent.name })
        break
      case 'idle':
        intents.push({ kind: 'agent-idle', agent: agent.name })
        break
      default:
        break
    }
  }
  return intents
}

/**
 * Resolve a dispatch_activity event's dispatchAgentId to the agent name: the
 * dispatched agent's own pill carries that id in its dispatches[] metadata.
 */
export function agentOfActivity(agents: AgentStateUpdate[], dispatchAgentId: string): string | undefined {
  return ownerOfDispatch(agents, dispatchAgentId)
}

/** Map cross-cutting events (permission, status, tool activity) to intents. */
export function eventIntents(events: NormalizedEvent[], agents: AgentStateUpdate[]): Intent[] {
  const intents: Intent[] = []
  for (const event of events) {
    switch (event.type) {
      case 'dispatch_start': {
        // Primary delivery trigger: the engine emits this for every depth on
        // the conversation stream. Root dispatches come from the manager;
        // nested ones from the owning lead (resolved via the snapshot).
        const owner = event.dispatchParentId ? ownerOfDispatch(agents, event.dispatchParentId) : undefined
        intents.push({
          kind: 'deliver',
          from: event.dispatchParentId === '' ? 'manager' : (owner ?? 'manager'),
          toAgent: event.dispatchAgent,
        })
        intents.push({ kind: 'agent-working', agent: event.dispatchAgent })
        break
      }
      case 'permission_request': {
        // The waiting artwork tells the operator WHAT needs them: a ready
        // plan (ExitPlanMode), a question (AskUserQuestion), or a plain
        // permission gate.
        const bubble =
          event.toolName === 'ExitPlanMode' ? 'plan' : event.toolName === 'AskUserQuestion' ? 'question' : 'permission'
        intents.push({ kind: 'permission-wait', bubble })
        break
      }
      case 'status':
        // The orchestrator's own state: the manager mirrors it at his desk.
        if (event.fields?.state === 'running') {
          intents.push({ kind: 'permission-clear' })
          intents.push({ kind: 'manager-working' })
        } else if (event.fields?.state === 'idle' || event.fields?.state === 'completed') {
          intents.push({ kind: 'manager-idle' })
        }
        break
      case 'dispatch_activity': {
        if (event.dispatchActivityKind !== 'tool_start' && event.dispatchActivityKind !== 'tool_end') break
        const agent = agentOfActivity(agents, event.dispatchAgentId)
        if (agent) {
          intents.push({
            kind: 'agent-activity',
            agent,
            toolName: event.dispatchActivityKind === 'tool_start' ? (event.toolName ?? null) : null,
          })
        }
        break
      }
      default:
        break
    }
  }
  return intents
}

/** Display name helper for toolbar/tooltip surfaces. */
export function displayNameOf(agent: AgentStateUpdate): string {
  return meta<string>(agent, 'displayName', agent.name)
}
