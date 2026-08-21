// ─── Git Types ───
//
// Extracted from types-session.ts to keep that file under the 600-line cap.
// Re-exported from types-session.ts so existing import paths keep working.

// Type-only import: `WorktreeInfo` lives in types-session.ts (which re-exports
// this file). Type-only imports are erased at compile time, so this does not
// create a runtime module cycle.
import type { WorktreeInfo } from './types-session'

export interface GitCommit {
  hash: string
  fullHash: string
  parents: string[]
  authorName: string
  authorDate: string
  subject: string
  refs: GitRef[]
}

export interface GitRef {
  name: string
  type: 'head' | 'remote' | 'tag'
  isCurrent: boolean
}

export interface GitCommitDetail {
  filesChanged: number
  insertions: number
  deletions: number
}

export interface GitCommitFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  oldPath?: string
}

export interface GitGraphData {
  commits: GitCommit[]
  isGitRepo: boolean
  totalCount: number
}

export type GitConflictKind = 'UU' | 'AA' | 'DD' | 'AU' | 'UA' | 'DU' | 'UD'

export interface GitDiffResult {
  diff: string
  fileName: string
  /** Git classified this change as binary, so no diff content is transferred. */
  isBinary: boolean
}

export interface GitChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict'
  staged: boolean
  oldPath?: string
  conflictKind?: GitConflictKind
  isSubmodule?: boolean
}

export interface GitChangesData {
  files: GitChangedFile[]
  branch: string
  isGitRepo: boolean
  ahead: number
  behind: number
}

export interface GitBranchInfo {
  name: string
  isCurrent: boolean
  upstream: string | null
  isRemote: boolean
}

// ─── Worktree lifecycle ───

/**
 * How a land integrated the worktree branch into its source branch.
 *
 * - `ref-advance` — the source branch was checked out in NO worktree, so the
 *   ref was advanced directly (`git fetch . <wt>:<source>`). Zero working-tree
 *   impact: nobody's checkout moved.
 * - `merge` — the source branch IS checked out somewhere, so the merge ran in
 *   place in that worktree after a dirty/branch preflight.
 * - `fast-forward` — the worktree branch was already fully contained in the
 *   source (or vice-versa); the ref moved without creating a merge commit.
 */
export type LandMode = 'ref-advance' | 'merge' | 'fast-forward'

/** Result of a land attempt. Refusals carry an actionable `error`. */
export interface LandResult {
  ok: boolean
  mode?: LandMode
  /** Source-branch commit after a successful land. */
  sha?: string
  error?: string
  /** True when the failure was a merge conflict (distinct from a refusal). */
  hasConflicts?: boolean
  /**
   * The checkout left holding the conflict, when `hasConflicts` is set.
   *
   * Required because a land can conflict in either of two places: the optional
   * pre-sync conflicts in the WORKTREE, while the merge itself conflicts in
   * whichever checkout holds the source branch (often the base repo). A client
   * that assumed the worktree would point its resolution UI at a clean
   * directory half the time.
   */
  conflictDirectory?: string
  /** Set when the operation succeeded but a side-effect (registry persist) failed. */
  warning?: string
  /**
   * Bench directories removed because disenrolling the landed worktree left them
   * with no members. Reported so the caller can close tabs at gone paths.
   */
  prunedBenchPaths?: string[]
}

/**
 * What the bulk sync pass did with ONE worktree.
 *
 * - `synced`        — rebased cleanly onto the source tip.
 * - `replayed`      — rebased, with at least one stop completed from a
 *                     recorded rerere resolution. A different fact from
 *                     `synced` (a stale recording is not conflict-free work),
 *                     so it is never silently equated.
 * - `conflicted`    — a genuine conflict stands; the worktree is mid-rebase
 *                     and the resolution surfaces (dialog / AI assist) apply.
 * - `skipped-dirty` — uncommitted work; never touched, same rule as the
 *                     single-row verb.
 * - `skipped-clean` — nothing to do: already current or already landed.
 * - `skipped-unknown-source` — source branch unknown; sync is unanswerable.
 * - `failed`        — the machinery failed for a reason that is not a
 *                     conflict (unreadable status, git error).
 */
export interface SyncAllWorktreeOutcome {
  worktreePath: string
  branchName: string
  /** Human title when the worktree has one; clients fall back to the path slug. */
  title?: string
  outcome: 'synced' | 'replayed' | 'conflicted' | 'skipped-dirty' | 'skipped-clean' | 'skipped-unknown-source' | 'failed'
  /** Unmerged paths when `conflicted`. */
  conflictedPaths?: string[]
  /**
   * Commits omitted from the replay because the source branch already carried
   * their content, byte for byte by `git patch-id`.
   *
   * Absent (rather than 0) when nothing was dropped, so a row that shed
   * duplicate history reads differently from an ordinary sync — see
   * worktree/patch-identity.ts for why a precise-base rebase has to compute
   * this itself.
   */
  dropped?: number
  error?: string
}

/** Result of the bulk sync pass over every worktree of a repo. */
export interface SyncAllResult {
  /** False only when the pass itself could not run; per-worktree failures ride `outcomes`. */
  ok: boolean
  outcomes: SyncAllWorktreeOutcome[]
  summary: {
    synced: number
    replayed: number
    conflicted: number
    skippedDirty: number
    skippedClean: number
    skippedUnknownSource: number
    failed: number
    /** Total commits dropped as already-upstream across every worktree in the pass. */
    dropped: number
  }
  error?: string
}

export interface LandAndRetireResult extends LandResult {
  /** True when integration succeeded even if checkout cleanup needs a retry. */
  landed?: boolean
  /** Source repository used only as a race fallback for an occupant that became busy. */
  workingDirectory?: string
}

/** Result of retiring or re-attaching a worktree. */
export interface WorktreeMoveResult {
  ok: boolean
  /**
   * Directory the caller should relocate the conversation into: the repo root
   * after a retire, the new worktree path after a re-attach.
   */
  workingDirectory?: string
  /** Populated on re-attach: the freshly created worktree. */
  worktree?: WorktreeInfo
  /**
   * Populated when a forced retire preserved uncommitted work: the full ref
   * name in the parent repo (`refs/ion/recovery/...`) holding a snapshot commit.
   * Absent when the worktree was clean, so there was nothing to preserve.
   *
   * Surfaced to the operator rather than only logged: a ref they cannot see is
   * indistinguishable from work that was silently destroyed.
   */
  recoveryRef?: string
  /**
   * Bench directories this retire REMOVED, because disenrolling the worktree
   * left them with no members (`disenrollWorktree`).
   *
   * Reported rather than only logged because a bench directory hosts real
   * conversations and a terminal: a caller that closes the retired worktree's
   * tabs but not these would leave them pointed at a path that no longer
   * exists. Empty (or absent) when the worktree belonged to no bench, or when
   * every bench holding it retained other members.
   */
  prunedBenchPaths?: string[]
  error?: string
  /** Set when the operation succeeded but a side-effect (registry persist) failed. */
  warning?: string
}

/**
 * Where a worktree is in the provisioning lifecycle.
 *
 * Provisioning materialises the gitignored dependency state a checkout needs but
 * git will never carry (`node_modules`, hooks, build caches). It runs behind the
 * worktree rather than blocking it, so this state is what the UI renders while
 * the work happens.
 *
 * `ready` is also the state of a worktree in a repo with no manifest at all —
 * "nothing to do" and "everything done" are indistinguishable to a consumer, and
 * should be.
 */
export type WorktreeProvisionState =
  | 'idle'
  | 'probing'
  | 'seeding'
  | 'building'
  | 'ready'
  | 'failed'

/**
 * An in-progress git operation in a checkout. `none` is represented by the
 * field being absent, so consumers switch on presence.
 */
export type GitOperationState = 'rebasing' | 'merging' | 'cherry-picking'

// ─── Work stages ───

/**
 * Where a worktree is in the operator's own workflow.
 *
 * A curated, fixed vocabulary — deliberately not configurable. The engine of
 * this feature is "one optional marker per worktree, plus one automatic
 * transition", and any subset of the stages is a complete workflow: a
 * two-state operator uses only `bug` and `verified`, a full-pipeline operator
 * walks all seven. No ordering is enforced and no verb is gated on a stage;
 * the marker is a note to the operator, not a state machine the app acts on
 * (with the single exception below).
 *
 * The one automatic transition: `bug` moves to `test` when the worktree's
 * bench pin advances (new content was integrated). "There is an issue to fix"
 * becomes "the fix is in, retest it" at exactly the moment the new content
 * lands in the bench — which is the moment the old flag stops being true.
 * Every other stage survives a pin advance: `verified` is a statement about
 * the feature, not the pin, so only the operator moves it.
 */
export type WorkStage = 'plan' | 'build' | 'test' | 'bug' | 'verified' | 'merge' | 'ready'

/** One stage's shared semantics. Glyph + colour stay client-side. */
export interface WorkStageDescriptor {
  id: WorkStage
  label: string
  /** What selecting this stage MEANS, for tooltips and menus. */
  hint: string
  /** Stage to auto-move to when the worktree's bench pin advances. */
  onPinAdvance?: WorkStage
}

/**
 * The stage vocabulary, in workflow order (which is also display order in
 * every picker). Order here is presentational only — nothing enforces it.
 */
export const WORK_STAGES: readonly WorkStageDescriptor[] = [
  { id: 'plan', label: 'Planning', hint: 'Planning work is happening here' },
  { id: 'build', label: 'Building', hint: 'Implementation in progress' },
  { id: 'test', label: 'Needs testing', hint: 'Look at this again after the next build' },
  {
    id: 'bug', label: 'Issue found', hint: 'A problem was found and needs fixing',
    // The fix arriving in the bench is what makes "issue open" stale and
    // "retest" true, so the transition rides the pin advance.
    onPinAdvance: 'test',
  },
  { id: 'verified', label: 'Verified', hint: 'Tested and working' },
  { id: 'merge', label: 'Merge checks', hint: 'Alignment, squash, and pre-merge checks' },
  { id: 'ready', label: 'Ready to land', hint: 'All checks done — land when ready' },
] as const

/** Descriptor lookup. Returns undefined for an unknown value from an older record. */
export function workStageDescriptor(stage: string | undefined): WorkStageDescriptor | undefined {
  return WORK_STAGES.find((s) => s.id === stage)
}

/**
 * The legacy review-verdict vocabulary (`good` | `issue`) mapped onto stages.
 *
 * ONE table, three consumers: the workspaces-file load migration
 * (bench-store.ts), the deprecated `benchSetReview` preload shim, and any
 * future reader of a pre-stage record. `good` meant "reviewed, the feature
 * works" → `verified`; `issue` meant "this contribution has a bug" → `bug`.
 * `null` clears in both vocabularies. Anything else maps to undefined —
 * unknown verdicts are dropped, never guessed.
 */
export function legacyReviewToStage(review: unknown): WorkStage | null | undefined {
  if (review === null) return null
  if (review === 'good') return 'verified'
  if (review === 'issue') return 'bug'
  return undefined
}

/**
 * One worktree in the inventory, with everything a client needs to describe it
 * and decide what to offer. Mirrors WorktreeInventoryEntry in
 * main/worktree/inventory.ts; kept in shared/ so the renderer and iOS wire can
 * both name it.
 */
export interface WorktreeInventoryEntry {
  worktreePath: string
  branchName: string
  /** Display label, derived from the worktree directory name. */
  label: string
  /**
   * Human-readable description of what this worktree is FOR, generated from the
   * first prompt sent in it or set by the operator.
   *
   * Absent until a worktree has been named. Every other identifier a worktree
   * carries (`ion-03e81090`, `wt/ion-03e81090`, a commit sha) is a machine
   * string that says nothing about the work, so clients render this in the
   * primary position and keep the machine strings for the hover detail. Falling
   * back to `label` when absent is the client's job.
   */
  title?: string
  /**
   * Null when Ion did not create this worktree and cannot know what it was cut
   * from. Land/sync/staleness are unanswerable in that case, so clients must
   * ask rather than guess -- a wrong source branch lands work in the wrong place.
   */
  sourceBranch: string | null
  head: string
  lastCommitSubject: string
  isDirty: boolean
  unlandedCommitCount: number
  needsSync: boolean
  safeToDiscard: boolean
  /**
   * When this worktree's commits were landed into its source branch, or absent
   * when they have not been.
   *
   * A STORED fact, written by the land verb. It cannot be derived afterwards: a
   * worktree that never committed and one whose work landed both end up clean
   * with zero unlanded commits and a tip equal to their merge base, so every
   * git probe answers identically for both. Absent therefore means NOT landed,
   * never "unknown" -- which is what keeps a freshly created empty worktree out
   * of the landed group. See the registry field comment for the full reasoning.
   */
  landedAt?: number
  /**
   * The operator's workflow stage for this worktree, or absent when none is
   * set. Recorded in the worktree registry — it describes the worktree's
   * lifecycle, not one bench pin — so it exists for unenrolled worktrees too.
   * See `WorkStage` for the vocabulary and the one automatic transition.
   */
  stage?: WorkStage
  /**
   * Set while a rebase/merge/cherry-pick is in progress in this worktree. A
   * conflicted sync stops mid-rebase with HEAD detached; the worktree used to
   * vanish from the inventory in that state (the detached-HEAD skip), which is
   * exactly when the operator most needs to see it. While set, the appraisal
   * fields above are conservative defaults, not live answers — mid-operation
   * they are meaningless.
   */
  operationState?: GitOperationState
  /** Unmerged paths when the operation is conflicted. Absent when clean. */
  conflictedPaths?: string[]
  /** Provisioning lifecycle state. Absent on worktrees created before this existed. */
  provisionState?: WorktreeProvisionState
  /** Operator-facing reason when `provisionState` is `failed`. */
  provisionError?: string
}

/** What removing a worktree would cost. Mirrors main/worktree/safety.ts. */
export interface WorktreeAppraisalWire {
  hasUncommittedChanges: boolean
  uncommittedPaths: string[]
  unlandedCommitCount: number
  fullyLanded: boolean
  safeToDiscard: boolean
  reason?: string
  appraisalFailed?: boolean
}

// ─── Integration workspace (the "bench") ───

// ─── Integration Bench Types ───
//
// Bench types live in types-bench.ts (extracted to keep this file under the
// 600-line cap). Re-exported here so existing import paths keep working.
export type {
  PinState, MergeOutcome,
  IntegrationMember, BenchPriorResolution, IntegrationWorkspace, BenchAssembleResult,
} from './types-bench'
