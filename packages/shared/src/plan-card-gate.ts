// Pure render-gate helper for the Plan Ready (ExitPlanMode) approval card.
//
// An orchestrator can call ExitPlanMode and have its run exit while a
// background dispatch it spawned is still running. The plan at that instant is
// provisional: when the dispatch reports back the orchestrator resumes,
// revises the plan, and re-presents it. Showing the Plan Ready card during
// that window misleads the user into thinking the plan is final when the turn
// is effectively still active.
//
// This helper decides whether the plan-exit card should be SUPPRESSED right
// now. It suppresses only the ExitPlanMode (Plan Ready) card and only while a
// background dispatch is running. An AskUserQuestion card is a direct question
// to the user and is never invalidated by a background dispatch, so it is never
// suppressed here. A generic permission request is a live blocking request and
// is likewise out of scope.
//
// The suppression is a DEFERRAL, not a loss: the underlying permissionDenied /
// permissionQueue entry is untouched; only its presentation is gated. The card
// reappears on the next render once the dispatch ends (the running child
// clears) and the proposal/denial is still present.

/** Tool names present in the pending denial (the card's `tools` list). */
export interface PlanCardGateInput {
  /** Tool names in the pending permission denial / queue for this card. */
  toolNames: readonly string[]
  /** True when at least one background dispatch agent is in `running` status. */
  hasRunningChildren: boolean
}

/**
 * Returns true when the pending denial is the ExitPlanMode (Plan Ready)
 * variant. AskUserQuestion takes precedence: a denial that contains an
 * AskUserQuestion is treated as a question card, not a plan-exit card (mirrors
 * PermissionDeniedCard's `isPlanExit` / `isAskQuestion` precedence).
 */
export function isPlanExitDenial(toolNames: readonly string[]): boolean {
  const isAskQuestion = toolNames.includes('AskUserQuestion')
  return !isAskQuestion && toolNames.includes('ExitPlanMode')
}

/**
 * Returns true when the Plan Ready card should be suppressed (deferred) right
 * now because it is the plan-exit variant AND a background dispatch is still
 * running. Returns false for AskUserQuestion / generic cards, and false when no
 * dispatch is running (the normal Plan Ready case renders).
 */
export function shouldSuppressPlanCardForDispatch(input: PlanCardGateInput): boolean {
  return isPlanExitDenial(input.toolNames) && input.hasRunningChildren
}

/**
 * Resolve the suppression decision for a conversation's pending denial and log
 * the deferral when it fires. Returns false when there is no pending denial.
 * Kept here (rather than inline in ConversationView) so the component stays
 * under its size cap and the decision + its observability live in one place.
 *
 * `log` is injected so this helper has no console dependency of its own; the
 * renderer passes `console.log` (forwarded to desktop.log). It is called only
 * on the suppression branch.
 */
export function resolvePlanCardSuppression(args: {
  toolNames: readonly string[] | null | undefined
  hasRunningChildren: boolean
  tabId: string
  runningChildCount: number
  log: (msg: string) => void
}): boolean {
  if (!args.toolNames) return false
  const suppress = shouldSuppressPlanCardForDispatch({
    toolNames: args.toolNames,
    hasRunningChildren: args.hasRunningChildren,
  })
  if (suppress) {
    args.log(
      `[plan-card] tab=${args.tabId.slice(0, 8)} suppressing Plan Ready card — ${args.runningChildCount} background dispatch(es) still running (deferred until they finish)`,
    )
  }
  return suppress
}
