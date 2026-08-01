/**
 * worktree-list — "what worktrees exist here, and how does the bench relate to
 * each one".
 *
 * ── Why the join is a module and not a component detail ─────────────────────
 * A worktree and a bench member are the same object seen from two angles. They
 * used to be two records and two rows: `IntegrationMember` re-declared
 * `worktreePath`, `branchName`, and `label`, and it still needed `title`, which
 * it did not have -- so the wire layer resolved the title by joining against the
 * inventory and documented the join as a workaround. The join was already the
 * truth; it was just performed late, once, in one projection, where no other
 * consumer could reach it.
 *
 * So the join lives here, in `shared/`, for the same reason
 * `worktree-conversations.ts` does: the renderer, the ATV mirror, and the
 * main-process wire projection all need the same answer, and three
 * implementations of one fact is how surfaces disagree. It is deliberately PURE
 * -- plain arrays in, plain data out, no store and no Electron -- so it is
 * trivially testable and safe to import from either process.
 *
 * ── Merge order is array order ──────────────────────────────────────────────
 * `IntegrationWorkspace.members` is ordered and assembly merges in that order, so
 * the displayed sequence number is derived here (`index + 1`) and never stored.
 * An explicit `order` field would be a second source of truth that could
 * disagree with the array the merge actually walks.
 */
import type {
  WorktreeInventoryEntry,
  IntegrationWorkspace,
  IntegrationMember,
  EnrollmentState,
} from './types-git'

/** One row in the unified list: a worktree, plus its bench membership if any. */
export interface WorktreeListItem {
  entry: WorktreeInventoryEntry
  /** Absent when this worktree belongs to no bench. */
  membership?: IntegrationMember
  /**
   * 1-based position in the bench's merge order. Undefined when unenrolled.
   * Derived from array position at join time -- see the header note.
   */
  order?: number
  enrollment: EnrollmentState
  /**
   * This worktree's work reached its source branch, and nothing new is waiting.
   *
   * Read from the STORED `landedAt`, never inferred. `safeToDiscard` looks like
   * the same question and is not: it means "nothing to lose", which is equally
   * true of a worktree that has never committed anything. Sorting on it would
   * file every freshly created empty worktree under Landed -- exactly the wrong
   * claim, and unrecoverable afterwards, since git cannot tell "never started"
   * from "landed" once both are clean and fully merged.
   *
   * The `unlandedCommitCount === 0` half still matters: a worktree that landed
   * and then kept committing is active again, not done.
   *
   * Sorted into its own band at the BOTTOM rather than removed -- it is still a
   * real worktree with conversations in it. An ENROLLED worktree never sinks:
   * the bench holds its pin, which is a live obligation whatever its own
   * history.
   */
  landed: boolean
}

/**
 * A membership whose worktree is no longer in the inventory.
 *
 * These are NOT rendered as rows. A row implies a directory the operator can
 * open, and an absorbed or deleted worktree has none -- inventing a row for it
 * would offer verbs that cannot run. They surface as a footnote on the bench
 * bar instead, which keeps them addressable: before this, an absorbed member's
 * row simply vanished and the absorption notice was its only trace.
 */
export interface OrphanMembership {
  membership: IntegrationMember
  sourceBranch: string
}

export interface WorktreeListResult {
  items: WorktreeListItem[]
  orphans: OrphanMembership[]
}

/** Enrollment is derived: no record at all is `none`, a record reads `enabled`. */
function enrollmentOf(membership: IntegrationMember | undefined): EnrollmentState {
  if (!membership) return 'none'
  return membership.enabled ? 'included' : 'excluded'
}

/**
 * Join the worktree inventory against bench memberships.
 *
 * `activeBench` selects WHICH bench's membership decorates the rows, because a
 * repo can integrate into several source branches at once and a row can only
 * show one membership. Passing `null` (or a branch with no workspace) yields a
 * plain unenrolled list -- the correct answer for a repo with no bench, not an
 * error.
 *
 * Sort: enrolled first in merge order, then everything else by recency, so the
 * stack the bench will build is the first thing read.
 */
export function buildWorktreeList(
  entries: readonly WorktreeInventoryEntry[],
  workspaces: readonly IntegrationWorkspace[],
  activeBench: string | null,
): WorktreeListResult {
  const workspace = activeBench
    ? workspaces.find((w) => w.sourceBranch === activeBench)
    : undefined

  // Position in this map IS merge order; it is read once here and never stored.
  const byPath = new Map<string, { membership: IntegrationMember; order: number }>()
  workspace?.members.forEach((membership, i) => {
    byPath.set(membership.worktreePath, { membership, order: i + 1 })
  })

  const items: WorktreeListItem[] = entries.map((entry) => {
    const hit = byPath.get(entry.worktreePath)
    return {
      entry,
      membership: hit?.membership,
      order: hit?.order,
      enrollment: enrollmentOf(hit?.membership),
      // Done means: this worktree's work reached the source branch (`landedAt`,
      // the stored witness) and nothing has been committed since
      // (`unlandedCommitCount`).
      //
      // ── Why enrollment does not veto this ────────────────────────────────
      // It used to. The reasoning was "a bench member has a live obligation --
      // its pin -- whatever its own landing state", which holds only while the
      // pin carries UNLANDED work. Once the work is in the source branch the
      // bench receives that content from its base whether or not the member is
      // merged, so the pin has become a duplicate rather than an obligation.
      // `bench-assemble` agrees and acts on it: `isLandedIntoSource` retires such
      // a member and marks its pin `absorbed`. Pinning the row to the active
      // band therefore contradicted the bench's own model and stranded a
      // finished worktree at the top of the list until the next assembly.
      //
      // An `absorbed` pin is treated the same way for the same reason: the
      // bench has already dissolved the membership.
      //
      // A member whose pin still holds unlanded work is NOT done, and
      // `landedAt` cannot be set in that case -- landing is what sets it -- so
      // the two conditions above already exclude it. Nothing needs enrollment
      // to say so.
      landed: !!entry.landedAt && entry.unlandedCommitCount === 0,
    }
  })

  // A membership with no inventory entry: the worktree was retired, absorbed,
  // or is otherwise gone. Reported separately rather than dropped, so the bench
  // can still say what it is holding.
  const present = new Set(entries.map((e) => e.worktreePath))
  const orphans: OrphanMembership[] = (workspace?.members ?? [])
    .filter((m) => !present.has(m.worktreePath))
    .map((membership) => ({ membership, sourceBranch: workspace!.sourceBranch }))

  items.sort(compareListItems)
  return { items, orphans }
}

/**
 * Three bands: enrolled (in merge order), then active, then landed -- with
 * landedness checked FIRST, so a bench member whose work has already reached the
 * source branch sinks with the rest of the finished work instead of holding its
 * rail position at the top.
 *
 * Within the active and landed bands, rows keep the inventory's own order, which
 * is already recency -- re-sorting them here would be a second opinion about an
 * order the inventory has already decided.
 */
function compareListItems(a: WorktreeListItem, b: WorktreeListItem): number {
  // Landedness is the OUTERMOST band, ahead of enrollment. A landed worktree
  // needs no attention even while it is still nominally a bench member, and
  // ranking enrollment first kept exactly that row pinned to the top of the
  // list -- the bug this ordering fixes. Its merge position is meaningless once
  // the bench is taking the content from its base instead.
  if (a.landed !== b.landed) return a.landed ? 1 : -1

  const aEnrolled = a.order !== undefined
  const bEnrolled = b.order !== undefined
  if (aEnrolled && bEnrolled) return a.order! - b.order!
  if (aEnrolled) return -1
  if (bEnrolled) return 1
  return 0
}

/**
 * The bench membership of one worktree, across every workspace in a repo.
 *
 * Used by surfaces that act on a worktree without knowing which bench is on
 * screen (the row menu's enroll/unenroll, the retire path). Returns the first
 * match: a worktree belongs to at most one bench per source branch, and
 * enrolling the same worktree in two benches of one repo is refused upstream.
 */
export function findMembership(
  workspaces: readonly IntegrationWorkspace[],
  worktreePath: string,
): { membership: IntegrationMember; sourceBranch: string } | undefined {
  for (const ws of workspaces) {
    const membership = ws.members.find((m) => m.worktreePath === worktreePath)
    if (membership) return { membership, sourceBranch: ws.sourceBranch }
  }
  return undefined
}
