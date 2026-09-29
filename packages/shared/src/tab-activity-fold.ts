import type { ConversationPane } from './types-engine'
import type { StatusFields } from './types-engine'

/** Tristate "waiting for the user" derived from queued permission denials. */
export type WaitingState = 'plan-ready' | 'question' | null

/**
 * Derive the waiting state from a denial-tools array. Returns 'question' if
 * any tool is AskUserQuestion, else 'plan-ready' if any is ExitPlanMode, else
 * null. Shared by both CLI and engine paths.
 */
function waitingStateFromTools(
  tools: ReadonlyArray<{ toolName: string }> | undefined | null,
): WaitingState {
  if (!tools?.length) return null
  if (tools.some((t) => t.toolName === 'AskUserQuestion')) return 'question'
  if (tools.some((t) => t.toolName === 'ExitPlanMode')) return 'plan-ready'
  return null
}

/**
 * Pane-scoped waiting-state fold, shared so the cross-client snapshot builder
 * (`remote-projection.ts`, now server-owned) can compute the same waiting
 * indicator every rendering client shows, without importing renderer-bound
 * display code. `activeQuestionsCount` is passed in by the caller (rather
 * than imported here) so this module stays free of a store dependency: the
 * questions store lives at a different layer on each consumer (server-side
 * store vs. desktop renderer store) and both already know how to look up
 * their own count.
 *
 * Checked FIRST and short-circuits: a pending question outranks a plan
 * proposal, matching `waitingStateFromTools`' own precedence. An open Guided
 * Questions round is a waiting state and is NOT discoverable from
 * `permissionDenied` — AskUserQuestion denials are deliberately filtered out
 * of that field so the wizard owns the surface instead of a second,
 * competing card.
 */
export function waitingStateOfPane(
  pane: ConversationPane | undefined,
  activeQuestionsCountForTab: number,
): WaitingState {
  if (activeQuestionsCountForTab > 0) return 'question'

  if (!pane || pane.instances.length === 0) return null
  let hasPlanReady = false
  for (const inst of pane.instances) {
    const ws = waitingStateFromTools(inst.permissionDenied?.tools)
    if (ws === 'question') return 'question'
    if (ws === 'plan-ready') hasPlanReady = true
  }
  return hasPlanReady ? 'plan-ready' : null
}

/**
 * Canonical running-children count for a single conversation instance.
 *
 * Two data sources can report running background agents for the same
 * instance (per-agent `agentStates` entries and the aggregate
 * `statusFields.backgroundAgents` counter); taking the max prevents
 * double-counting when both are populated while still catching the
 * backgroundAgents-only case (plain conversations) that an agentStates-only
 * fold would miss. Shared for the same reason as {@link waitingStateOfPane} — the cross-client
 * snapshot builder needs the identical fold every rendering client uses.
 */
export function effectiveRunningChildrenCount(inst: {
  agentStates: ReadonlyArray<{ status: string }>
  statusFields?: Pick<StatusFields, 'backgroundAgents' | 'backgroundShells' | 'activeBackgroundTasks' | 'hasPendingWork'> | null
}): number {
  let fromAgentStates = 0
  for (const a of inst.agentStates) {
    if (a.status === 'running') fromAgentStates++
  }
  const fromBackgroundAgents = inst.statusFields?.backgroundAgents ?? 0
  return Math.max(fromAgentStates, fromBackgroundAgents)
}
