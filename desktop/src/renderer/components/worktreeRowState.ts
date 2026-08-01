/**
 * worktreeRowState — which single indicator a worktree row shows, and why.
 *
 * ── Why this is a pure function and not inline JSX ──────────────────────────
 * The row has ONE state slot in its fixed-width gutter, and a worktree can be
 * several things at once: mid-rebase, behind its bench pin, failing to
 * provision, reviewed-with-an-issue. Something has to choose. Keeping that
 * choice inline would make it untestable except by rendering, and would let the
 * ordering drift every time a branch is added.
 *
 * So the decision is data. The row renders what this returns; the test asserts
 * what this returns. One decision, two consumers, no drift.
 *
 * ── Priority is severity, and nothing is hidden ─────────────────────────────
 * The slot shows the most severe fact. Every fact it does NOT show still
 * reaches the operator: the second line carries the words (`excluded`,
 * `behind`, `sync blocked`), and the hover card carries the full identity. That
 * is what makes a single slot honest -- it is a summary, not a filter.
 *
 * This is only possible because member state is three orthogonal axes. Under
 * the old collapsed `MemberStatus` an excluded member that had also moved on
 * reported only `excluded`; the other facts were not lower priority, they were
 * destroyed at write time and no renderer could have recovered them.
 */
import type { IntegrationMember, WorktreeInventoryEntry } from '../../shared/types'

/**
 * What the state slot shows. A discriminated union rather than a string so the
 * row cannot render a kind it has no branch for.
 */
export type RowStateIndicator =
  /** A rebase/merge/cherry-pick is in progress IN the worktree. Click resolves. */
  | { kind: 'operation-conflict'; operation: string; conflictedCount: number }
  /** The bench could not merge this member's pinned contribution. */
  | { kind: 'bench-conflict'; paths: string[]; conflictsWith: string[] }
  /** Dependency provisioning failed; the worktree cannot build. */
  | { kind: 'provision-failed'; reason?: string }
  /** The worktree has committed past what the bench holds. Click updates the pin. */
  | { kind: 'pin-behind'; pinnedSha: string }
  /** The source branch moved and a sync would change this worktree. */
  | { kind: 'needs-sync'; blocked: boolean; syncing: boolean }
  /** Dependencies are being installed right now. */
  | { kind: 'provisioning' }
  /** Nothing needs attention. The slot still reserves its width. */
  | { kind: 'none' }

export interface RowStateInput {
  entry: WorktreeInventoryEntry
  membership?: IntegrationMember
  syncing?: boolean
}

/**
 * Resolve the one indicator for this row.
 *
 * Order, and why each rung outranks the next:
 *
 * 1. An in-worktree conflicted operation. The worktree is mid-rebase; its other
 *    numbers are conservative defaults and the only useful act is Resolve.
 * 2. A bench merge conflict. The contribution is not in the build at all, which
 *    outranks any question of freshness.
 * 3. Failed provisioning. A worktree that cannot build is not waiting on a sync.
 * 4. A moved base. Ranked ABOVE the pin because syncing rewrites the worktree's
 *    commits, so any pin taken first is immediately stale -- see the note at the
 *    branch itself. Disabled, not hidden, when the worktree is dirty.
 * 5. A behind pin. The bench holds older content than the worktree.
 * 6. Provisioning in flight. Transient and self-resolving.
 *
 * Review verdicts are NOT in this chain. They used to occupy rungs 4 and 7, from
 * when the only place a verdict could appear was this slot -- but the verdict
 * BUTTONS on line 2 are always visible and already show the state they set, so a
 * gutter copy meant every reviewed row carried the same mark twice. Two glyphs
 * per row for one fact is what makes a list hard to scan.
 */
export function resolveRowState(input: RowStateInput): RowStateIndicator {
  const { entry, membership, syncing } = input

  if (entry.operationState) {
    return {
      kind: 'operation-conflict',
      operation: entry.operationState,
      conflictedCount: entry.conflictedPaths?.length ?? 0,
    }
  }

  if (membership?.merge === 'conflicted') {
    return {
      kind: 'bench-conflict',
      paths: membership.conflictPaths ?? [],
      conflictsWith: membership.conflictsWith ?? [],
    }
  }

  if (entry.provisionState === 'failed') {
    return { kind: 'provision-failed', reason: entry.provisionError }
  }

  // ── Sync outranks a behind pin, and the order is not a preference ─────────
  // Sync is `git rebase <sourceBranch>` (main/worktree/integrate.ts), which
  // rewrites every commit in the worktree -- new shas AND a new tree. So a pin
  // advanced before a sync is stale the instant the sync finishes: the operator
  // pays a bench assembly for it, then has to advance the pin again. Worse, that
  // intermediate pin publishes PRE-REBASE content to anyone who reassembles the
  // bench in the window between the two.
  //
  // Held unconditionally, including when the worktree is dirty and the sync
  // therefore cannot run. Reordering on dirty state would move the control the
  // operator is reaching for depending on a fact they may not have noticed, and
  // the honest answer in both cases is the same: clean the worktree, sync, then
  // pin. The blocked control says so rather than offering the step that must
  // come second.
  if (entry.needsSync) {
    return { kind: 'needs-sync', blocked: entry.isDirty, syncing: !!syncing }
  }

  if (membership?.pin === 'behind') {
    return { kind: 'pin-behind', pinnedSha: membership.pinnedSha }
  }

  if (entry.provisionState === 'seeding'
    || entry.provisionState === 'building'
    || entry.provisionState === 'probing') {
    return { kind: 'provisioning' }
  }

  return { kind: 'none' }
}

/**
 * The words for line 2: every fact the slot could not show.
 *
 * Returned as data for the same reason the indicator is: the row renders them,
 * the test asserts them, and "the slot showed X so Y must still be visible" is
 * checkable rather than a claim in a comment.
 */
export function resolveRowWords(input: RowStateInput): string[] {
  const { entry, membership, syncing } = input
  const shown = resolveRowState(input)
  const words: string[] = []

  if (entry.operationState) words.push('conflict · Resolve')
  // Kept even when the slot shows the operation conflict: "the bench dropped
  // this" and "this worktree is mid-rebase" are different problems with
  // different fixes.
  if (membership?.merge === 'conflicted' && shown.kind !== 'bench-conflict') words.push('bench conflict')
  if (entry.provisionState === 'failed' && shown.kind !== 'provision-failed') words.push('setup failed')

  // The exclusion fact has no slot of its own -- the enrollment control already
  // shows it -- but it belongs in the words so a dimmed row explains itself.
  if (membership && !membership.enabled) words.push('excluded')

  if (membership?.pin === 'behind' && shown.kind !== 'pin-behind') words.push('behind')
  if (membership?.pin === 'empty') words.push('no commits yet')
  if (membership?.pin === 'absorbed') words.push('landed')
  if (membership?.pin === 'gone') words.push('worktree gone')

  if (entry.needsSync && syncing) words.push('syncing')
  else if (entry.needsSync && entry.isDirty && shown.kind !== 'needs-sync') words.push('sync blocked')
  else if (entry.needsSync && entry.isDirty && shown.kind === 'needs-sync') words.push('sync blocked')

  if (entry.provisionState === 'seeding' || entry.provisionState === 'building' || entry.provisionState === 'probing') {
    if (shown.kind !== 'provisioning') words.push('installing deps')
  }

  return words
}
