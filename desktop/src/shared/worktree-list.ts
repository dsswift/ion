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
 * `worktree-conversations.ts` does: the renderer, the Studio mirror, and the
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
  /**
   * This worktree's work reached its source branch. `landedAt` is a terminal
   * witness, not a live Git classification: once recorded it is never cleared
   * and later branch movement must not return the checkout to active work.
   */
  landed: boolean
  /**
   * The active conversation is standing in this worktree.
   *
   * Exactly one row can carry it (or none, when the active conversation is in a
   * bench, the main clone, or an unrelated directory). Derived HERE rather than
   * in a component because every worktree surface — the overlay panel, the Studio window
   * mirror, the wire projection — decorates through this one function, and a
   * second local computation is precisely the drift this module exists to stop.
   */
  active: boolean
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
  /**
   * Directory the ACTIVE conversation is working in, or null/undefined when
   * there is none. Matched against each worktree's own path to mark one row.
   *
   * A directory, not a worktree path, because the caller cannot always know
   * which it has: a conversation created through the worktree flow carries
   * `tab.worktree.worktreePath`, one opened directly in the directory carries
   * only `workingDirectory`, and both are genuinely standing in the worktree.
   * Matching on the path means either resolves correctly, and a bench or
   * unrelated directory matches nothing — which is the right answer, since the
   * bench has its own bar.
   */
  activeDirectory?: string | null,
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
      // `landedAt` is only written by a successful Land and is never cleared.
      // Git cannot recover that witness after the fact, so no current branch
      // count may override it.
      landed: !!entry.landedAt,
      // Exact path equality, never a prefix test: a worktree whose name merely
      // begins with another's (`ion-a3372546` vs `ion-a33725460`) would
      // highlight the wrong row, and a nested subdirectory of a worktree is
      // still that worktree — but the callers pass a checkout root, so equality
      // is both sufficient and unambiguous.
      active: !!activeDirectory && entry.worktreePath === activeDirectory,
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
  // Landedness is the OUTERMOST band, ahead of membership. A landed worktree
  // needs no attention even while it is still nominally a bench member, and
  // ranking membership first kept exactly that row pinned to the top of the
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

/**
 * Human-readable age of a bench's last assembly, e.g. "assembled 5m ago".
 *
 * Both bench surfaces (the overlay git panel's BenchBar and the Studio
 * Inbox's InboxBenchBar) need the exact same wording, so it lives here
 * rather than in either component -- a second, textually-drifted copy is
 * exactly the outcome this shared module exists to prevent.
 */
export function benchAssembledRelativeTime(lastBuiltAtMs: number): string {
  if (!lastBuiltAtMs) return 'never assembled'
  const secs = Math.round((Date.now() - lastBuiltAtMs) / 1000)
  if (secs < 60) return 'assembled just now'
  if (secs < 3600) return `assembled ${Math.round(secs / 60)}m ago`
  if (secs < 86400) return `assembled ${Math.round(secs / 3600)}h ago`
  return `assembled ${Math.round(secs / 86400)}d ago`
}

/**
 * The bench header's one-line status: how many members it holds, how many of
 * them are out of date, and when it was last assembled.
 *
 * ── Why all three facts, and why they are one string ────────────────────────
 * These answer one question ("can I trust what the bench currently holds?") and
 * each is useless alone. The previous version showed the member-behind count
 * INSTEAD of the assembly age, so a bench with a stale member hid how old the
 * build was, and a bench with no stale members hid how many members it had at
 * all -- a bench that has silently lost every member reads identically to a
 * healthy one. An operator looking at "assembled 9h ago" cannot tell whether
 * that is fine (nothing has moved since) or badly stale (four members have
 * committed since), which is exactly the judgement the count supplies.
 *
 * Assembly FAILURE still replaces everything: when the last assembly failed the
 * bench is empty, and member freshness is not the operator's problem yet.
 *
 * Shared for the same reason `benchAssembledRelativeTime` is: the overlay's
 * BenchBar, the Studio Inbox's InboxBenchBar, and iOS all render this line, and
 * three copies of the wording is how they drift.
 */
export function benchMemberSummary(
  workspace: Pick<IntegrationWorkspace, 'members' | 'lastBuiltAt' | 'lastAssembly' | 'lastAssemblyFailure'>,
): string {
  if (workspace.lastAssembly === 'failed') {
    return workspace.lastAssemblyFailure === 'verification' ? 'Verification failed' : 'Assembly failed'
  }
  const total = workspace.members.length
  if (total === 0) return 'no members'
  // `behind` is the pin verdict for "the worktree has content the bench does
  // not hold". `gone` is deliberately excluded: it is a broken membership, not
  // a stale one, and it already surfaces as an orphan on the bench bar.
  const behind = workspace.members.filter((member) => member.pin === 'behind').length
  const members = `${total} member${total === 1 ? '' : 's'}`
  const age = benchAssembledRelativeTime(workspace.lastBuiltAt)
  return behind > 0 ? `${members} · ${behind} out of date · ${age}` : `${members} · ${age}`
}
