/**
 * session-busy-guard — pure predicate answering "is this tab's session busy?".
 *
 * Originally extracted from tab-slice.ts (file-size cap) as a close-only guard.
 * It is now consumed by every verb that would destroy in-flight work, so it is
 * named for the QUESTION it answers rather than for one caller's verb.
 *
 * ─── Who consumes it ─────────────────────────────────────────────────────
 *   • closeTab (tab-slice.ts) and requestCloseTab (close-intent-slice.ts) —
 *     closing a tab tears the session down.
 *   • convertToWorktree (worktree-slice.ts) — converting relocates the tab, and
 *     relocation is `restartTabEntry` + `ensureSession`
 *     (main/engine-control-plane-relocate.ts). Step 1 calls `stopSession`, so a
 *     conversion kills exactly the same orchestrator run, dispatched children,
 *     and background shells that a close does. The engine pins a session's
 *     working directory at start_session, so the restart is inherent to
 *     relocation and cannot be engineered away — the verb has to be refused
 *     while the tab is busy instead.
 *
 * ─── What "busy" means ───────────────────────────────────────────────────
 * Hard-block while the orchestrator is running, while dispatched background
 * agents are still executing, or while background bash commands the session is
 * waiting on are still running. Mirrors the X-button suppression in
 * TabStripTabPill.tsx and exists for defense-in-depth — it catches keyboard
 * shortcuts (Cmd+W → CloseTabConfirmDialog), group-pill close paths, the
 * context-menu convert row, and any future entry point we haven't enumerated.
 *
 * No escape hatch: there is no `force` flag. Either the tab is completely idle
 * (no orchestrator activity, no dispatched background children, no outstanding
 * background commands) and the verb is allowed, or the tab is active and the
 * user must stop it first (via the in-pane Interrupt button, or by waiting for
 * natural completion). The user's path is: interrupt → wait for idle → retry.
 * This protects dispatched background agents from accidental SIGTERM.
 *
 * Background bash commands are protected for the same reason: tearing the
 * session down runs the engine's StopBackgroundTasksForOwner, which kills the
 * session's running shell processes. A long build or test run dying because a
 * tab was closed or converted is the same footgun as a killed sub-agent.
 *
 * Internal cleanup paths (tab close after the single engine instance is torn
 * down) abort the orchestrator above the call site, which propagates to children
 * — by the time those paths reach this guard, the tab's state should already be
 * quiescent. If a race window means agents haven't yet flipped to terminal
 * status, the guard fires, the warn is logged, and the next snapshot tick (after
 * agents finish aborting) allows the operation.
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
  statusFields?: { state?: string; backgroundAgents?: number; backgroundShells?: number; hasPendingWork?: boolean } | null
  agentStates?: Array<{ status?: string } | null> | null
}

/** Minimal pane shape the guard reads. */
interface GuardPane {
  instances?: GuardInstance[] | null
}

export interface SessionBusyResult {
  /** True when the operation must be refused. */
  blocked: boolean
  /** Whether the orchestrator (any instance) is non-idle. */
  orchestratorRunning: boolean
  /** Per-instance running-child counts (for the refusal log). */
  childCounts: Array<{ id: string; count: number }>
  /** Total outstanding background bash commands across instances. */
  shellCount: number
}

/**
 * Evaluate whether a tab's session is busy — the orchestrator is running, a
 * dispatched background agent is still executing, or a background bash command
 * is outstanding. Pure — no store access, no side effects. The caller logs the
 * refusal and returns early when `blocked`.
 *
 * Returns `blocked: false` when there is no pane or no instances (nothing to
 * protect) — a tab with no live conversation work is never busy.
 */
export function evaluateSessionBusyGuard(pane: GuardPane | null | undefined): SessionBusyResult {
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
    const rosterRunning = agents.filter((a) => a?.status === 'running').length
    const running = Math.max(rosterRunning, inst.statusFields?.backgroundAgents ?? 0)
    childCounts.push({ id: inst.id, count: running })
    shellCount += inst.statusFields?.backgroundShells ?? 0
    if (inst.statusFields?.hasPendingWork) {
      childCounts.push({ id: `${inst.id}:pending`, count: 1 })
    }
  }
  const childRunning = childCounts.some((c) => c.count > 0)
  return {
    blocked: orchestratorRunning || childRunning || shellCount > 0,
    orchestratorRunning,
    childCounts,
    shellCount,
  }
}

/**
 * Build the refusal warning line for a blocked operation (keeps the message in
 * one place).
 *
 * `action` names the verb that was refused — "close the tab", "convert the tab
 * to a worktree" — so a reader of ~/.ion/desktop.jsonl can tell which surface
 * refused without correlating timestamps against the call site.
 */
export function formatSessionBusyRefusal(
  tabId: string,
  result: SessionBusyResult,
  action: string,
): string {
  return (
    `refused to ${action}: tabId=${tabId.slice(0, 8)} ` +
    `orchestratorRunning=${result.orchestratorRunning} ` +
    `childCounts=${JSON.stringify(result.childCounts.map((c) => `${c.id.slice(0, 6)}:${c.count}`))} ` +
    `backgroundShells=${result.shellCount}` +
    ` — user must stop the tab (interrupt + wait for children and background commands) before they can ${action}`
  )
}

/**
 * The OPERATOR-facing phrase for why a tab is busy — "running", "2 background
 * agents running", or several joined together.
 *
 * Sibling of `formatSessionBusyRefusal`, which is the LOG line. Both live here,
 * next to `evaluateSessionBusyGuard`, because both are derived from its result
 * shape: a caller that re-derived "why" from raw pane state would be a second
 * definition of busy-ness that could disagree with the guard actually enforcing
 * the operation. The retire refusal quotes this, so the dialog the operator
 * reads and the guard that blocked the action cannot tell different stories.
 *
 * Returns the empty string when nothing is blocking. Callers only reach this
 * for a blocked result, but an empty answer is the honest one for an idle tab
 * rather than an invented reason.
 */
export function describeSessionBusyReason(result: SessionBusyResult): string {
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
