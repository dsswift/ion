/**
 * Integration-bench types — enrollment, pins, merge verdicts, and assembly.
 *
 * Split from types-git.ts at the 600-line cap, on the seam between what a
 * WORKTREE is (types-git: inventory, appraisal, stages, sync) and what a BENCH
 * does with a set of them (here: membership, pinned contributions, merge
 * outcomes, and the assembly result).
 *
 * That is also the ownership seam: a worktree exists whether or not any bench
 * knows about it, while every type in this file is meaningless without one.
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
 * One worktree's membership in a bench: a PIN, keyed by worktree path.
 * (The operator's review marker moved to the worktree registry as `stage` —
 * see `WorkStage` — because it describes the worktree's lifecycle, not one
 * pinned contribution.)
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
  /**
   * Prior resolutions recorded for this member's conflicted paths, newest first.
   *
   * Populated only on a conflicted member, and only when the journal holds a
   * matching entry (`~/.ion/integration-resolutions.json`). Attached to the
   * failure record so the surface that reports the conflict already carries the
   * context for resolving it — the same file colliding once per member is the
   * common case, and each of those resolutions used to start cold.
   *
   * ADVISORY. Nothing reads this to change a merge outcome; `git rerere` remains
   * the only mechanism that replays a resolution, because a recording keyed by
   * conflict text is verifiable and a paragraph of prose is not.
   */
  priorResolutions?: BenchPriorResolution[]
}

/**
 * One previously recorded resolution of a path, as a conflict report carries it.
 *
 * A projection of the journal entry, not the entry itself: the wire and the UI
 * need what a reader acts on, and the storage shape is free to grow fields
 * neither of them should have to know about.
 */
export interface BenchPriorResolution {
  path: string
  /** The member that was being merged when this resolution was made. */
  memberBranch: string
  /** Counterpart members whose pinned ranges also touched the path. */
  collidedWith: string[]
  resolvedAt: number
  /** Whether project verification ran AND passed for that resolution. */
  verified: boolean
  /** Why it went the way it did, in the resolver's words. Empty when unrecorded. */
  rationale: string
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
  /**
   * Which gate produced the failure, when `lastAssembly === 'failed'`.
   *
   * `'conflict'`: a member's pinned contribution would not merge; per-member
   * `conflictPaths`/`conflictsWith` carry the detail.
   * `'verification'`: every merge completed — including any replayed rerere
   * resolutions — but the project's `bench.verify` command rejected the
   * resulting tree. No member reports `conflicted`; `lastAssemblyVerification`
   * carries the evidence.
   * `'obstructed'`: the merge failed WITHOUT ever producing an unmerged index
   * entry — a structural signal, not a guess, since a genuine content
   * conflict always produces at least one. This is git refusing the merge
   * before it ever reaches conflict state (e.g. an untracked, non-ignored
   * file at a path the incoming branch wants to write) or some other
   * machinery-level failure. `lastAssemblyError` carries git's own error
   * text verbatim; there is no per-member conflict data to attach because
   * none was ever produced.
   *
   * Absent on a record written before this split, or on any failure this
   * split does not yet classify — clients must render that as an
   * unclassified failure, never default it to `'conflict'`.
   */
  lastAssemblyFailure?: 'conflict' | 'verification' | 'obstructed'
  /**
   * Evidence for a `'verification'` failure. Absent otherwise.
   *
   * Nothing here changes what merged: it is a record of what the project's
   * own verify command said about the tree the assembly produced.
   */
  lastAssemblyVerification?: {
    /** The exact `bench.verify` command that ran. */
    command: string
    /** Tail of the verify command's combined output, already truncated. */
    outputTail: string
    /**
     * Branch names of the members whose merge came from a replayed rerere
     * resolution rather than a clean merge — the suspects, since a replay is
     * the one thing this assembly introduced that the members' own commits
     * did not already contain.
     */
    replayedBranches: string[]
    /**
     * Set when the AI-assisted analysis verb has materialised the failing
     * combination back into the bench (see `prepareVerificationDiagnostic`)
     * so a client can say the bench currently holds that diagnostic tree
     * rather than the ordinary empty-after-failure state. Cleared by the
     * next real assembly.
     */
    diagnosticTreeAt?: number
  }
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
