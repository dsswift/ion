/**
 * Pure helper that derives the parent engine tab's status from
 * per-instance state. Used as the **specification** for the inline
 * derivation logic in snapshot.ts (the IIFE runs in renderer context
 * and cannot import this file, so the inline implementation must stay
 * in sync — reviewers verify that by visual diff).
 *
 * Rules (engine tabs only):
 *   - anyInstanceRunning → 'running'
 *   - terminal status ('dead' / 'failed') → preserve
 *   - 'completed' AND queue carries ExitPlanMode/AskUserQuestion
 *     → preserve 'completed' so the green (plan-ready) / blue
 *     (question) parent pill still shows after auto-allow
 *   - otherwise → 'idle'
 *
 * Non-engine tabs are not derived here (callers pass through).
 *
 * Phase 1 of the state-management overhaul shipped this derivation
 * inline in snapshot.ts (commit 85647b95). Phase 4 extracts the rules
 * to a pure helper so the contract is testable end-to-end. The
 * inline copy in snapshot.ts must match this function exactly.
 *
 * The helper is intentionally side-effect-free and takes only the
 * inputs it needs; no `state` or `enginePanes` access. This keeps the
 * unit tests trivial to set up and the contract reviewable in one
 * place.
 */

export type DeriveEngineParentStatusInput = {
  /** Whatever value the renderer currently has on `tab.status`. May
   *  be stale due to the active-instance gate in
   *  engine-event-status.ts — that staleness is the bug this
   *  derivation works around. */
  rendererStatus: string
  /** True iff any sub-instance under this engine tab reports its
   *  `inst.statusFields.state` as 'running', 'starting', or
   *  'connecting'. */
  anyInstanceRunning: boolean
  /** Permission-denied queue promoted onto the snapshot's permission
   *  queue. Only the tool names matter for derivation. */
  queueToolNames: string[]
}

export function deriveEngineParentStatus(input: DeriveEngineParentStatusInput): string {
  const { rendererStatus, anyInstanceRunning, queueToolNames } = input

  if (anyInstanceRunning) return 'running'
  if (rendererStatus === 'dead' || rendererStatus === 'failed') {
    return rendererStatus
  }
  if (rendererStatus === 'completed') {
    const hasWaitingDenial = queueToolNames.some(
      (n) => n === 'ExitPlanMode' || n === 'AskUserQuestion',
    )
    return hasWaitingDenial ? 'completed' : 'idle'
  }
  return 'idle'
}
