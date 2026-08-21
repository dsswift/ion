import type { AgentStateUpdate } from '../../shared/types'
import type { DispatchInfo } from '../../shared/types-engine'
import type { RankedStatusDot, StatusDotColors } from './agent-helpers'
import {
  activityTierForDispatch,
  getDispatches,
  hasLiveDescendantOfDispatch,
  mostRecentDispatch,
  resolveDotForStatus,
} from './agent-helpers'

/**
 * How one agent row's status indicator should render.
 *
 * Mirrors `getGroupDotModel`'s contract (TabStripGroupStatus.ts), which solves
 * the same problem for the tab-group pill: one dot when there is nothing to
 * split, two overlapping dots when the item in focus and the aggregate of the
 * rest can disagree.
 */
export type AgentDotModel =
  | { kind: 'single'; dot: RankedStatusDot }
  | { kind: 'stack'; foreground: RankedStatusDot; background: RankedStatusDot }

/**
 * Resolve the dot(s) for one agent row.
 *
 * ── Why two dots ────────────────────────────────────────────────────────────
 *
 * An agent row can own several dispatches, and folding them into ONE dot
 * destroys the distinction the operator actually needs. Consider a lead whose
 * most recent dispatch finished cleanly while an OLD dispatch still owns a
 * running specialist. A single aggregated dot renders that as plain "active",
 * indistinguishable from the lead itself working — so a specialist stalled
 * under a long-finished dispatch looks like normal progress and goes unnoticed.
 *
 * Splitting the two makes it legible at a glance:
 *
 *   • FOREGROUND — always the most recent dispatch. Fixed meaning. It does NOT
 *     depend on which dispatch the detail panel has selected; this function
 *     deliberately accepts no selected index, so no amount of paging around
 *     inside the popup can repoint what the collapsed row reports.
 *   • BACKGROUND — always the aggregate of the PREVIOUS dispatches, and never
 *     the most recent one. Excluding the most recent is what preserves the
 *     contrast: "current work done, something old still running" reads as green
 *     over pulsing yellow, while "currently working, history clean" reads as
 *     orange over green.
 *
 * Each dispatch derives its tier from durable dispatch metadata: running is
 * foreground, `waitingOn: 'children'` is child work, `waitingOn: 'shell'` is
 * shell work, and terminal entries are historical. No inferred descendant walk
 * can confuse sibling history with what this dispatch is waiting on.
 *
 * ── Collapse rule ───────────────────────────────────────────────────────────
 *
 * Fewer than two dispatches → a single dot, exactly as the group pill collapses
 * for a single-tab group. There is no "previous" set to summarize, so a second
 * dot would be noise. With two or more, the background dot always renders (it
 * is green when every earlier dispatch is cleanly finished), so its absence is
 * never ambiguous — a missing background dot means "no history", never "history
 * we declined to show".
 *
 * An agent carrying NO dispatches at all (an extension-roster pill) falls back
 * to its own status, which is all the information such a row has.
 */
export function resolveAgentDotModel(agent: AgentStateUpdate, colors: StatusDotColors): AgentDotModel
export function resolveAgentDotModel(agent: AgentStateUpdate, allAgents: AgentStateUpdate[], colors: StatusDotColors): AgentDotModel
export function resolveAgentDotModel(
  agent: AgentStateUpdate,
  allAgentsOrColors: AgentStateUpdate[] | StatusDotColors,
  legacyColors?: StatusDotColors,
): AgentDotModel {
  const allAgents = Array.isArray(allAgentsOrColors) ? allAgentsOrColors : undefined
  const colors = legacyColors ?? allAgentsOrColors as StatusDotColors
  const dispatches = getDispatches(agent)

  // Roster pill / pre-dispatch row: nothing but the agent's own status.
  if (dispatches.length === 0) {
    return { kind: 'single', dot: resolveDotForStatus(agent.status, colors) }
  }

  const recent = mostRecentDispatch(dispatches)
  const foreground = resolveDispatchDot(agent, recent, allAgents, colors)

  const previous = dispatches.filter((d) => d.id !== recent?.id)
  if (previous.length === 0) {
    return { kind: 'single', dot: foreground }
  }

  // Highest-priority state across the earlier dispatches wins the background
  // dot, the same fold `getGroupStatusColor` performs across a group's tabs.
  let background = resolveDispatchDot(agent, previous[0], allAgents, colors)
  for (const d of previous.slice(1)) {
    const candidate = resolveDispatchDot(agent, d, allAgents, colors)
    if (candidate.priority > background.priority) background = candidate
  }

  return { kind: 'stack', foreground, background }
}

/**
 * Dot for a single dispatch of an agent.
 *
 * Dispatch status and `waitingOn` are durable dispatch fields. Agent status is
 * fallback only for legacy entries without a dispatch status.
 */
export function resolveDispatchDot(
  agent: AgentStateUpdate,
  dispatch: DispatchInfo | undefined,
  colors: StatusDotColors,
): RankedStatusDot
export function resolveDispatchDot(
  agent: AgentStateUpdate,
  dispatch: DispatchInfo | undefined,
  allAgents: AgentStateUpdate[] | undefined,
  colors: StatusDotColors,
): RankedStatusDot
export function resolveDispatchDot(
  agent: AgentStateUpdate,
  dispatch: DispatchInfo | undefined,
  allAgentsOrColors: AgentStateUpdate[] | StatusDotColors | undefined,
  legacyColors?: StatusDotColors,
): RankedStatusDot {
  const allAgents = Array.isArray(allAgentsOrColors) ? allAgentsOrColors : undefined
  const colors = legacyColors ?? allAgentsOrColors as StatusDotColors
  const status = dispatch?.status || agent.status
  const tier = activityTierForDispatch(dispatch)
  const waitingOn = tier === 'children'
    ? 'children'
    : tier === 'shell'
      ? 'shell'
      : dispatch?.waitingOn
  const inferredChildren = allAgents && dispatch
    ? hasLiveDescendantOfDispatch(allAgents, dispatch.id)
    : false
  return resolveDotForStatus(status, colors, waitingOn ?? (inferredChildren ? 'children' : undefined))
}
