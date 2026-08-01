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

/**
 * ── Three orthogonal axes, not one enum ─────────────────────────────────────
 *
 * A member's state used to be a single `MemberStatus` union mixing three
 * INDEPENDENT questions: is it enrolled, how fresh is its pin, and what did the
 * last merge do. A member can be excluded AND behind AND conflicted at the same
 * time, and one enum can report only one of those — so every evaluation threw
 * two facts away.
 *
 * That was not theoretical. `refreshStaleness` carried a priority ladder whose
 * own comment admitted it ("never overwrite a conflict verdict with a staleness
 * verdict"), and the ordering meant an excluded member that had also moved on
 * reported only `excluded`: re-enabling it produced a silently stale merge with
 * no warning anywhere. Three fields cannot mask each other, so the ladder is
 * gone and every axis is always readable.
 */

/**
 * Is this worktree in a bench, and does it take part in the merge?
 *
 * Derived for display (`none` when there is no membership record at all); the
 * durable half is `WorktreeMembership.enabled`.
 */
export type EnrollmentState = 'none' | 'included' | 'excluded'

/**
 * How the bench's pinned contribution relates to the worktree's real content.
 *
 * - `empty` — the pin carries no commits: the member branch has nothing of its
 *   own beyond the source branch, so there is nothing to merge. NOT terminal
 *   and NOT an error — it is the honest state of a worktree enrolled before its
 *   first commit, which is the natural way to start work you intend to
 *   integrate. It becomes `behind` the moment it commits.
 * - `current` — the pinned contribution matches what the member branch holds.
 * - `behind` — the member branch's committed content has moved past the pin.
 *   Advisory only: nothing reassembles until the operator says so.
 * - `absorbed` — the contribution is now contained in the source branch itself,
 *   so it is permanently part of the bench's base and needs no merge. Terminal;
 *   the member retires on the next assembly. Distinguished from `empty` by the
 *   contribution RANGE — absorption applies only to a pin that carried commits.
 * - `gone` — the branch or worktree no longer exists.
 */
export type PinState = 'empty' | 'current' | 'behind' | 'absorbed' | 'gone'

/**
 * What the last assembly did with this member's pinned contribution.
 *
 * Owned by `bench-assemble.ts`, which is the only thing that merges. Staleness
 * evaluation never touches it — that separation is what lets a conflicted
 * member also report that it has moved on.
 */
export type MergeOutcome = 'unbuilt' | 'merged' | 'conflicted' | 'skipped'

/**
 * One worktree's membership in a bench: a PIN plus a VERDICT, keyed by worktree
 * path.
 *
 * ── Why this holds no worktree fields ───────────────────────────────────────
 * This record used to re-declare `worktreePath`, `branchName`, and `label`, and
 * it still needed `title`, which it did not have — so the wire layer resolved
 * the title by joining against the inventory and documented the join as a
 * workaround. The join was already the truth; it was just done late, once, in
 * one projection. Making membership a sidecar means every worktree fact arrives
 * from the worktree itself and the two can never disagree.
 *
 * A member contributes its **committed** work only: the tree of its branch
 * HEAD. Uncommitted work in a worktree cannot reach the bench — see
 * `IntegrationWorkspace` for why that is a hard rule rather than a default.
 */
export interface IntegrationMember {
  /** Absolute path of the member worktree. Identity within a workspace. */
  worktreePath: string
  branchName: string
  /** False = kept in the list but skipped in the merge. */
  enabled: boolean
  /** Pin freshness. Owned by staleness evaluation. */
  pin: PinState
  /** Last merge outcome. Owned by assembly. */
  merge: MergeOutcome
  /**
   * Operator verdict on the CURRENT pinned contribution.
   *
   * Scoped to the pin, not to the worktree: it answers "I reviewed THIS
   * contribution", so advancing the pin clears it. Absent means unreviewed —
   * distinct from reviewed-and-fine, which is why this is optional rather than
   * a three-valued flag defaulting to neutral.
   */
  review?: 'good' | 'issue'
  /**
   * The exact contribution currently integrated. Assembly merges THIS, never a
   * fresh read of the member's tip -- that is what stops an assembly triggered
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
   * own, and no git query at assembly time can recover that fact — a member that
   * has not started and a member whose work has landed both leave `pinnedSha` an
   * ancestor of the source branch with an empty `sourceBranch..pinnedSha`. The
   * bench used to read the first case as the second and silently delete the
   * member.
   *
   * Empty means UNKNOWN (a record written before this was tracked, or a branch
   * with no common ancestor), never "empty contribution". Assembly resolves an
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
  /** Populated when `merge === 'conflicted'`. */
  conflictPaths?: string[]
  /** Branch names of earlier-merged members this one collided with. */
  conflictsWith?: string[]
  /**
   * Set when `merge === 'merged'` and the merge succeeded only because a
   * recorded conflict resolution was replayed (`git rerere`). Observable on
   * purpose: a replayed resolution is deterministic but it is NOT the same
   * fact as a clean merge, and hiding the difference would make a stale
   * recording indistinguishable from conflict-free work.
   */
  mergeResolution?: 'replayed'
}

/**
 * An integration workspace: a reassemblable bench worktree whose contents are a
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
 * **Assembly is atomic.** The bench presents either the exact enrolled
 * combination or nothing: when any enabled member's merge cannot complete
 * (including via a replayed rerere resolution), the whole assembly fails and
 * the bench is wiped to an empty tree. A partial bench that silently omitted
 * one member's work was the worse alternative — the operator tested a
 * combination that misrepresented what was enrolled. Partial-on-purpose stays
 * available through the per-member exclude toggle.
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
 * assembly time, so the empty case is decided from the recorded contribution range
 * and reported as `pending` rather than retired. Retiring it was a real defect:
 * a worktree enrolled before its first commit was deleted from the member list on
 * every assembly.
 */
export interface IntegrationWorkspace {
  repoPath: string
  sourceBranch: string
  /** Bench worktree location (~/.ion/integration/<repo>-<slug>). */
  benchPath: string
  /** Bench branch (ion/bench/<slug>), recreated from scratch on every assembly. */
  benchBranch: string
  /** Merge order. */
  members: IntegrationMember[]
  /** Source-branch commit the last assembly started from. */
  baseSha: string
  /** Unix ms of the last assembly attempt; 0 when never assembled. */
  lastBuiltAt: number
  /**
   * Outcome of the last assembly. Absent on records written before atomic
   * assembly existed — clients must treat absence as "unknown", not as a
   * failure. `failed` means the bench was wiped to an empty tree and holds
   * NO member content until the conflict is resolved and assembly succeeds.
   */
  lastAssembly?: 'assembled' | 'failed'
  /** Operator-facing reason when `lastAssembly` is `failed`. */
  lastAssemblyError?: string
}

/** Outcome of an assembly attempt. */
export interface BenchAssembleResult {
  ok: boolean
  workspace?: IntegrationWorkspace
  /**
   * Members retired during this assembly because their work landed into the
   * source branch. Their content is now part of the bench's base permanently.
   * Surfaced so the UI can tell the operator what was absorbed rather than
   * having rows vanish silently.
   */
  retired?: IntegrationMember[]
  /** Refusal reason (dirty bench, running conversation, git failure). */
  error?: string
  /**
   * Set when the refusal is a guard the operator can resolve.
   * `resolution-in-progress`: a resolve-once merge is open in the bench;
   * assembling would destroy the very merge being resolved, so it refuses
   * until the merge is completed or aborted.
   */
  refusal?: 'dirty-bench' | 'conversation-running' | 'resolution-in-progress'
  /**
   * Non-blocking collision warning from the pin-advance dry-run
   * (`git merge-tree --write-tree`): the update proceeded, but the NEXT
   * assembly will conflict. Warn, never gate — the operator decides whether
   * to resolve now or keep working.
   */
  warning?: string
}


