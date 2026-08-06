/**
 * tab-close-guard — pure predicate for the closeTab action-layer guard.
 *
 * Extracted from tab-slice.ts (file-size cap). The closeTab action calls
 * {@link evaluateCloseGuard} before tearing a tab down; when the result is
 * `blocked`, the action returns early and the close is refused.
 *
 * ─── Action-layer guard ──────────────────────────────────────────────────
 * Hard-block conversation tab close while the orchestrator is running, while
 * dispatched background agents are still executing, or while background bash
 * commands the session is waiting on are still running. Mirrors the X-button
 * suppression in TabStripTabPill.tsx and exists for defense-in-depth — it
 * catches keyboard shortcuts (Cmd+W → CloseTabConfirmDialog), group-pill close
 * paths, and any future entry point we haven't enumerated.
 *
 * No escape hatch: there is no `force` flag. Either the tab is completely idle
 * (no orchestrator activity, no dispatched background children, no outstanding
 * background commands) and close is allowed, or the tab is active and the user
 * must stop it first (via the in-pane Interrupt button, or by waiting for
 * natural completion). The user's path to close an active tab is: interrupt →
 * wait for idle → close. This protects dispatched background agents from
 * accidental SIGTERM via tab close.
 *
 * Background bash commands are protected for the same reason: closing the tab
 * runs the engine's StopBackgroundTasksForOwner, which kills the session's
 * running shell processes. A long build or test run dying because a tab was
 * closed is the same footgun as a killed sub-agent.
 *
 * Internal cleanup paths (tab close after the single engine instance is torn
 * down) abort the orchestrator above the call site, which propagates to children
 * — by the time those paths reach this guard, the tab's state should already be
 * quiescent. If a race window means agents haven't yet flipped to terminal
 * status, the guard fires, the warn is logged, and the next snapshot tick (after
 * agents finish aborting) allows the close.
 *
 * TAB-TYPE-AGNOSTIC: the guard applies to every conversation tab, plain or
 * extension-hosted. The Agent tool dispatches background sub-agents regardless
 * of whether a harness is loaded, so a plain conversation can have running
 * children too — the dispatched-agent kill footgun is not engine-tab-specific.
 * The fold reads per-instance statusFields.state + agentStates (the same
 * agnostic data isAnyEngineInstanceRunning / anyEngineInstanceHasRunningChildren
 * in TabStripShared.ts read), and collapses correctly for a single-`main`-
 * instance plain tab. (A prior `tabHasExtensions` gate here excluded plain tabs
 * and let Cmd+W silently kill their running sub-agents — fixed.)
 */

/** Minimal instance shape the guard reads. */
interface GuardInstance {
  id: string
  statusFields?: { state?: string; backgroundShells?: number } | null
  agentStates?: Array<{ status?: string } | null> | null
}

/** Minimal pane shape the guard reads. */
interface GuardPane {
  instances?: GuardInstance[] | null
}

export interface CloseGuardResult {
  /** True when the close must be refused. */
  blocked: boolean
  /** Whether the orchestrator (any instance) is non-idle. */
  orchestratorRunning: boolean
  /** Per-instance running-child counts (for the refusal log). */
  childCounts: Array<{ id: string; count: number }>
  /** Total outstanding background bash commands across instances. */
  shellCount: number
}

/**
 * Evaluate whether a tab's close should be blocked because its orchestrator or
 * any dispatched background agent is still running. Pure — no store access, no
 * side effects. The caller logs the refusal and returns early when `blocked`.
 *
 * Returns `blocked: false` when there is no pane or no instances (nothing to
 * protect) — a tab with no live conversation work closes freely.
 */
export function evaluateCloseGuard(pane: GuardPane | null | undefined): CloseGuardResult {
  const childCounts: Array<{ id: string; count: number }> = []
  if (!pane || !pane.instances) {
    return { blocked: false, orchestratorRunning: false, childCounts, shellCount: 0 }
  }

  let orchestratorRunning = false
  let shellCount = 0
  for (const inst of pane.instances) {
    const state = inst.statusFields?.state
    if (state === 'running' || state === 'connecting' || state === 'starting') {
      orchestratorRunning = true
    }
    const agents = inst.agentStates || []
    const running = agents.filter((a) => a?.status === 'running').length
    childCounts.push({ id: inst.id, count: running })
    shellCount += inst.statusFields?.backgroundShells ?? 0
  }
  const childRunning = childCounts.some((c) => c.count > 0)
  return {
    blocked: orchestratorRunning || childRunning || shellCount > 0,
    orchestratorRunning,
    childCounts,
    shellCount,
  }
}

/** Build the refusal warning line for a blocked close (keeps the message in one place). */
export function formatCloseGuardRefusal(tabId: string, result: CloseGuardResult): string {
  return (
    `[closeTab] refused tab close: tabId=${tabId.slice(0, 8)} ` +
    `orchestratorRunning=${result.orchestratorRunning} ` +
    `childCounts=${JSON.stringify(result.childCounts.map((c) => `${c.id.slice(0, 6)}:${c.count}`))} ` +
    `backgroundShells=${result.shellCount}` +
    ' — user must stop the tab (interrupt + wait for children and background commands) before closing'
  )
}

/**
 * The OPERATOR-facing phrase for why a tab is busy — "running", "2 background
 * agents running", or several joined together.
 *
 * Sibling of `formatCloseGuardRefusal`, which is the LOG line. Both live here,
 * next to `evaluateCloseGuard`, because both are derived from its result shape:
 * a caller that re-derived "why" from raw pane state would be a second
 * definition of busy-ness that could disagree with the guard actually enforcing
 * the close. The retire refusal quotes this, so the dialog the operator reads
 * and the guard that blocked the close cannot tell different stories.
 *
 * Returns the empty string when nothing is blocking. Callers only reach this
 * for a blocked result, but an empty answer is the honest one for an idle tab
 * rather than an invented reason.
 */
export function describeCloseGuardReason(result: CloseGuardResult): string {
  const parts: string[] = []
  if (result.orchestratorRunning) parts.push('running')
  const children = result.childCounts.reduce((sum, c) => sum + c.count, 0)
  if (children > 0) {
    parts.push(`${children} background ${children === 1 ? 'agent' : 'agents'} running`)
  }
  if (result.shellCount > 0) {
    parts.push(`${result.shellCount} background ${result.shellCount === 1 ? 'command' : 'commands'} running`)
  }
  return parts.join(', ')
}
