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
 * How a land actually integrated the worktree branch into its source branch.
 *
 * - `ref-advance` — the source branch was checked out in NO worktree, so the
 *   ref was advanced directly (`git fetch . <wt>:<source>`). Zero working-tree
 *   impact: nobody's checkout moved.
 * - `merge` — the source branch IS checked out somewhere, so the merge ran in
 *   place in that worktree after a dirty/branch preflight.
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
  error?: string
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
  unlandedSubjects: string[]
  fullyLanded: boolean
  safeToDiscard: boolean
  reason?: string
  appraisalFailed?: boolean
}

// ─── Integration workspace (the "bench") ───

/**
 * Per-member state, computed on rebuild and on staleness evaluation.
 *
 * - `integrated` — the pinned contribution is merged and the member branch has
 *   not moved past it.
 * - `pending` — enrolled, but the pinned contribution is empty: the member
 *   branch carries no commits of its own beyond the source branch, so there is
 *   nothing to merge. NOT terminal and NOT an error — it is the honest state of
 *   a worktree enrolled before its first commit, which is the natural way to
 *   start work you intend to integrate. The member becomes `stale` the moment it
 *   commits, and Update pins the real work.
 * - `landed` — the contribution is now contained in the source branch itself,
 *   so it is part of the bench's base permanently and needs no merge. This is
 *   a terminal state: the member is retired from the list on the next rebuild.
 *   See `IntegrationWorkspace` for why landing is absorption, not removal.
 *   Distinguished from `pending` by the contribution range: absorption applies
 *   only to a pin that carried commits in the first place.
 * - `stale` — the member branch's committed content differs from what is
 *   pinned. Advisory only: nothing rebuilds until the operator says so.
 * - `conflicted` — the pinned contribution could not merge; the member was
 *   skipped and the rest of the bench still built.
 * - `missing` — the branch or worktree is gone.
 * - `excluded` — present in the member list but disabled, so skipped.
 */
export type MemberStatus =
  | 'integrated' | 'pending' | 'landed' | 'stale' | 'conflicted' | 'missing' | 'excluded'

/**
 * One worktree enrolled in an integration workspace.
 *
 * A member contributes its **committed** work only: the tree of its branch
 * HEAD. Uncommitted work in a worktree cannot reach the bench — see
 * `IntegrationWorkspace` for why that is a hard rule rather than a default.
 */
export interface IntegrationMember {
  /** Absolute path of the member worktree. Identity within a workspace. */
  worktreePath: string
  branchName: string
  /** Display label (defaults to the worktree directory name). */
  label: string
  /** False = kept in the list but skipped in the merge (`excluded`). */
  enabled: boolean
  /**
   * The exact contribution currently integrated. Rebuild merges THIS, never a
   * fresh read of the member's tip -- that is what stops a rebuild triggered
   * for one member from dragging in another member's half-finished work.
   * Advanced only by an explicit act: enrollment, or Update on this member.
   */
  pinnedSha: string
  pinnedTreeHash: string
  /**
   * Where the pinned contribution STARTS: the merge base of `pinnedSha` and the
   * source branch, captured when the pin was taken.
   *
   * The contribution is the range `pinnedBaseSha..pinnedSha`, not the tip. That
   * matters because an equal pair means the member has committed nothing of its
   * own, and no git query at rebuild time can recover that fact — a member that
   * has not started and a member whose work has landed both leave `pinnedSha` an
   * ancestor of the source branch with an empty `sourceBranch..pinnedSha`. The
   * bench used to read the first case as the second and silently delete the
   * member.
   *
   * Empty means UNKNOWN (a record written before this was tracked, or a branch
   * with no common ancestor), never "empty contribution". Rebuild resolves an
   * unknown value once against the member branch and backfills it.
   */
  pinnedBaseSha: string
  /**
   * The member's contribution as of the last staleness evaluation. Differs
   * from `pinnedTreeHash` exactly when the member is stale. Compared as a TREE
   * hash rather than a sha: an amend or reword produces a new sha with an
   * identical tree (a false stale), and a rebase changes content with no new
   * commit (a missed stale).
   */
  currentTreeHash: string
  status: MemberStatus
  /** Populated when `status === 'conflicted'`. */
  conflictPaths?: string[]
  /** Branch names of earlier-merged members this one collided with. */
  conflictsWith?: string[]
}

/**
 * An integration workspace: a rebuildable bench worktree whose contents are a
 * deterministic function of `(source tip, ordered member list)`.
 *
 * Keyed by `(repoPath, sourceBranch)`. That key is the mechanism that keeps
 * each project's — and each source branch's — integrations separate; blending
 * across projects is not possible by construction.
 *
 * **Only committed work integrates.** A member contributes the tree of its
 * branch HEAD, so uncommitted changes in a worktree cannot enter the bench.
 * This is deliberate and structural rather than a configurable default: a
 * bench built from a half-saved working tree represents a state that exists
 * nowhere in history and cannot be reproduced, reviewed, or landed. Committing
 * is the act that declares a unit of work coherent, and it is the same signal
 * the operator already uses to decide a change is ready. There is no mode that
 * relaxes this.
 *
 * **Landing is absorption, not removal.** When a member's work lands into the
 * source branch it becomes part of the bench's BASE — permanently, and with no
 * option to exclude it. The bench is rebuilt from the source tip, so the landed
 * work arrives with the base and needs no merge commit; git reports "Already
 * up to date" for it. The member record is then retired from the list, because
 * a member represents *pending* work to layer on top of the base, and this work
 * is no longer pending. Nothing is lost by retiring it: the content is in the
 * source branch, which is exactly where a pull request into the trunk reads
 * from. Disabling a landed member cannot remove its content either — `enabled`
 * governs whether a member's merge is applied, and there is no merge to skip.
 *
 * **Absorption applies only to a pin that carried commits.** A member whose
 * contribution is empty (`pinnedBaseSha === pinnedSha`) has not landed anything;
 * it has not started. Both cases look identical to every question asked at
 * rebuild time, so the empty case is decided from the recorded contribution range
 * and reported as `pending` rather than retired. Retiring it was a real defect:
 * a worktree enrolled before its first commit was deleted from the member list on
 * every rebuild.
 */
export interface IntegrationWorkspace {
  repoPath: string
  sourceBranch: string
  /** Bench worktree location (~/.ion/integration/<repo>-<slug>). */
  benchPath: string
  /** Bench branch (ion/bench/<slug>), recreated from scratch on every build. */
  benchBranch: string
  /** Merge order. */
  members: IntegrationMember[]
  /** Source-branch commit the last build started from. */
  baseSha: string
  /** Unix ms of the last successful rebuild; 0 when never built. */
  lastBuiltAt: number
}

/** Outcome of a rebuild attempt. */
export interface BenchRebuildResult {
  ok: boolean
  workspace?: IntegrationWorkspace
  /**
   * Members retired during this rebuild because their work landed into the
   * source branch. Their content is now part of the bench's base permanently.
   * Surfaced so the UI can tell the operator what was absorbed rather than
   * having rows vanish silently.
   */
  retired?: IntegrationMember[]
  /** Refusal reason (dirty bench, running conversation, git failure). */
  error?: string
  /** Set when the refusal is a guard the operator can resolve. */
  refusal?: 'dirty-bench' | 'conversation-running'
}


