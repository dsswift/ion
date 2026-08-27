/**
 * Worktree + integration-bench wire members (desktop → iOS).
 *
 * Extracted from protocol.ts, which is at its line cap. Re-exported from there
 * so the wire union stays in one place for consumers.
 *
 * Naming follows ADR-008: the desktop owns this wire, so every member carries
 * the `desktop_` prefix. The wire is lockstep — these types ship to
 * RemoteCommand.swift and NormalizedEvent.swift in the same change.
 */
import type { WorkStage } from '../../shared/types-git'

/**
 * One conversation open inside a worktree or bench directory.
 *
 * Replaces the earlier single `openTabId`, which could say only "something is
 * open here" — never which conversations, nor how many. A worktree routinely
 * hosts several, and collapsing them lost exactly the information that tells
 * one worktree's work apart from another's.
 */
export interface RemoteOpenConversation {
  tabId: string
  /** Display name: the operator's custom title when set, else the tab title. */
  title: string
  status: string
  /** 1-based position in the tab list, the number the desktop hint shows. */
  index: number
  /**
   * Optional lifecycle role. Bench lists use it to identify machine-owned
   * Auto-fix and Analysis conversations; ordinary worktree lists omit those
   * conversations entirely.
   */
  tabRole?: 'bench-conversation' | 'conflict-auto-fix' | 'verification-analysis'
}

/** One worktree, as iOS sees it. Mirrors WorktreeInventoryEntry. */
export interface RemoteWorktree {
  worktreePath: string
  branchName: string
  label: string
  /**
   * Human-readable description of what this worktree is FOR, generated from the
   * first prompt sent inside it. Absent until it has been named -- clients fall
   * back to `label` (the directory slug) and must not invent a placeholder.
   */
  title?: string
  /**
   * Null when Ion did not create the worktree and cannot know what it was cut
   * from. iOS must not offer land/sync for these -- guessing a source branch
   * would land work in the wrong place.
   */
  sourceBranch: string | null
  head: string
  lastCommitSubject: string
  isDirty: boolean
  unlandedCommitCount: number
  /** Feature branch has moved ahead AND a sync would change this worktree. */
  needsSync: boolean
  safeToDiscard: boolean
  /**
   * When this worktree's commits reached its source branch, or absent when they
   * have not.
   *
   * A STORED fact, written by the land verb. It cannot be derived afterwards: a
   * worktree that never committed and one whose work landed both end up clean
   * with zero unlanded commits, so `safeToDiscard` is true of both. Clients that
   * group "finished" work must read THIS, not `safeToDiscard`, or every freshly
   * created empty worktree is filed as if work had shipped.
   */
  landedAt?: number
  /**
   * The operator's workflow stage, or absent when none is set. Registry-scoped
   * on the desktop (it describes the worktree's lifecycle, not one bench pin),
   * so it exists for unenrolled worktrees too. Vocabulary:
   * shared/types-git.ts `WORK_STAGES`.
   */
  stage?: WorkStage
  /**
   * Where this worktree is in the dependency-provisioning lifecycle. Absent when
   * Ion has no record — a worktree created before provisioning existed, or one
   * whose record did not survive a desktop restart. Absent means "unknown", not
   * "not provisioned", so clients must not render it as a failure.
   */
  provisionState?: 'idle' | 'probing' | 'seeding' | 'building' | 'ready' | 'failed'
  /** Operator-facing reason when `provisionState` is `failed`. */
  provisionError?: string
  /**
   * Set while a rebase/merge/cherry-pick is in progress in this worktree — the
   * state a conflicted sync leaves behind. The appraisal fields above are
   * conservative defaults in that state, not live answers, so clients must not
   * present the worktree as healthy. Resolution is desktop-only (a 3-pane merge
   * does not translate to a phone); iOS renders the state and disables the
   * verbs that cannot run mid-operation.
   */
  operationState?: 'rebasing' | 'merging' | 'cherry-picking'
  /**
   * How many files are unmerged, when the operation is conflicted.
   *
   * A COUNT rather than the paths: the desktop rows render the number, and iOS
   * has no surface that lists conflicted paths (it cannot resolve them). Sending
   * the array would ship bytes no client reads. Absent when the operation is
   * clean or there is no operation.
   */
  conflictedCount?: number
  /**
   * Every conversation currently open in this worktree, in tab order. Empty
   * when none are. Clients focus one of these rather than stacking a duplicate,
   * and name them so the operator can see what the worktree holds.
   */
  openConversations: RemoteOpenConversation[]
  /**
   * This worktree's bench membership, when it belongs to one. Absent for an
   * unenrolled worktree. Every membership is part of the exact assembly set.
   */
  membership?: RemoteMembership
}

/**
 * One worktree's bench membership, as iOS sees it.
 *
 * Carries NO worktree fields. This used to be a whole `RemoteBenchMember` that
 * re-sent `worktreePath`, `branchName`, `label`, and a `title` the desktop had
 * to resolve by joining against the inventory -- so the wire shipped one
 * worktree twice, in two shapes, and iOS rendered it in two different rows.
 * Membership now decorates the worktree it belongs to.
 *
 * Pin freshness and merge outcome ship separately: a member can be behind and
 * conflicted, and the old single `status` could report only one of those.
 */
export interface RemoteMembership {
  /** Which bench: the source branch it integrates into. */
  sourceBranch: string
  pin: 'empty' | 'current' | 'behind' | 'absorbed' | 'gone'
  merge: 'unbuilt' | 'merged' | 'conflicted' | 'skipped'
  /** Short sha of the contribution currently integrated. */
  pinnedSha: string
  /** 1-based merge position, so a client can show the bench as an ordered stack. */
  order: number
  conflictPaths?: string[]
  conflictsWith?: string[]
  /**
   * Set when the merge succeeded only by replaying a recorded conflict
   * resolution (git rerere). Deterministic, but a different fact from a clean
   * merge — clients may surface it and must not treat absence as an error.
   */
  mergeResolution?: 'replayed'
}

/** One integration workspace, as iOS sees it. */
export interface RemoteBench {
  repoPath: string
  sourceBranch: string
  benchPath: string
  benchBranch: string
  /**
   * Memberships whose worktree is no longer in the inventory (absorbed into the
   * source branch, or retired). Sent so the bench can still say what it holds:
   * these have no directory to open, so they are a footnote rather than rows.
   */
  orphans: RemoteMembership[]
  baseSha: string
  lastBuiltAt: number
  /**
   * Outcome of the last assembly. `failed` means the bench was wiped to an
   * empty tree (atomic assembly) and holds NO member content until the
   * conflict is resolved. Absent on a record that predates atomic assembly —
   * clients render that as unknown, never as a failure.
   */
  lastAssembly?: 'assembled' | 'failed'
  /** Operator-facing reason when `lastAssembly` is `failed`. */
  lastAssemblyError?: string
  /**
   * Which gate produced the failure. `'conflict'` means a member's pinned
   * contribution would not merge (see the member's own `conflictPaths` /
   * `conflictsWith`). `'verification'` means every merge succeeded but the
   * project's own verify command rejected the resulting tree — no member
   * reports `conflicted`. `'obstructed'` means the merge failed without ever
   * producing an unmerged index entry — a structural signal (a genuine
   * conflict always produces at least one), not a per-member fact — so no
   * member reports `conflicted` here either; `lastAssemblyError` carries
   * git's own error text. Absent on a record written before this split, or on
   * a failure this split does not yet classify; clients must render that as
   * unclassified, never default it to `'conflict'`.
   */
  lastAssemblyFailure?: 'conflict' | 'verification' | 'obstructed'
  /**
   * Evidence for a `'verification'` failure. Absent otherwise. Read-only on
   * iOS — the three recovery verbs (dismiss, discard-and-reassemble, analyse)
   * are desktop-only, same posture as conflict resolution and recording purge.
   */
  lastAssemblyVerification?: {
    command: string
    outputTail: string
    replayedBranches: string[]
  }
  /** True when the feature branch has moved past the bench's base. */
  baseDrifted: boolean
  /** Conversations open in the bench directory, in tab order. */
  openConversations: RemoteOpenConversation[]
  /**
   * The bench's ONE persistent operator conversation when it is open, so a
   * client can focus it ("Go to") instead of creating another ("Talk").
   * Resolved by the tab's stored role (`tabRole === 'bench-conversation'`),
   * which is what distinguishes the singleton from the terminal and from
   * ephemeral auto-fix conversations sharing the same directory. Absent when
   * no singleton is open — and on any older desktop that does not send it,
   * which clients must render as "not open" rather than as an error.
   */
  benchConversationTabId?: string
  /**
   * The bench's dedicated terminal tab when one is open, so a client can say
   * "Go to terminal" instead of "Open terminal".
   *
   * One tab per bench, so this is a single id rather than a list — the desktop
   * derives it from the tab's own persisted state (terminal-only, in the bench
   * directory) rather than storing an id, so it is absent exactly when no such
   * tab exists. Absent also on any older desktop that does not send it, which
   * clients must render as "not open" rather than as an error.
   */
  benchTerminalTabId?: string
}

/** Per-repo worktree + bench state, keyed by repo path in the snapshot. */
export interface RemoteWorktreeState {
  repoPath: string
  worktrees: RemoteWorktree[]
  benches: RemoteBench[]
}

/** iOS → desktop worktree/bench commands. */
export type RemoteWorktreeCommand =
  | { type: 'desktop_worktree_refresh'; repoPath: string }
  | {
      type: 'desktop_worktree_open_conversation'
      worktreePath: string
      /**
       * Create an ADDITIONAL conversation rather than focusing an existing one.
       *
       * Absent/false is open-or-cycle, which is what tapping a row does. True is
       * the row menu's explicit "New conversation here" -- a distinct verb, so it
       * rides the same command with a flag rather than a parallel channel that
       * would duplicate the relay and the owner-window routing.
       */
      newConversation?: boolean
    }
  | { type: 'desktop_worktree_sync'; worktreePath: string; sourceBranch: string; repoPath: string }
  /**
   * Bulk sync: every managed worktree of the repo, sequentially, with rerere
   * replay between them (main/worktree/sync-all.ts). The MECHANICAL pass only:
   * the desktop's AI escalation (agents resolving leftover conflicts) is
   * desktop-only, same precedent as conflict resolution itself — see the
   * `operationState` comment above. iOS still benefits fully from the free
   * half: precise rebases plus replay of every recorded resolution.
   */
  | { type: 'desktop_worktree_sync_all'; repoPath: string }
  | { type: 'desktop_worktree_land_and_retire'; repoPath: string; worktreePath: string; worktreeBranch: string; sourceBranch: string }
  | { type: 'desktop_bench_open_conversation'; repoPath: string; sourceBranch: string }
  /**
   * Open (or focus) the bench's ONE dedicated terminal tab. Distinct from
   * `desktop_bench_open_conversation`: a shell and a conversation are different
   * things to want, and the desktop keeps exactly one terminal per bench rather
   * than stacking a new one per press.
   */
  | { type: 'desktop_bench_open_terminal'; repoPath: string; sourceBranch: string }
  | { type: 'desktop_bench_assemble'; repoPath: string; sourceBranch: string }
  | { type: 'desktop_bench_update_member'; repoPath: string; sourceBranch: string; worktreePath: string }
  | { type: 'desktop_bench_update_all'; repoPath: string; sourceBranch: string }
  /**
   * Set or clear the operator's workflow stage on a worktree. Worktree-scoped
   * (no sourceBranch): the stage lives in the desktop's worktree registry, not
   * on a bench member, so it applies to unenrolled worktrees too. `null`
   * clears — selecting the active stage in a picker un-sets it.
   */
  | { type: 'desktop_worktree_set_stage'; repoPath: string; worktreePath: string; stage: WorkStage | null }
  | { type: 'desktop_bench_reorder_member'; repoPath: string; sourceBranch: string; worktreePath: string; toIndex: number }
  /**
   * Retire every worktree in the repo already sealed by a successful Land.
   * Mirrors the desktop's "Retire all" control in the Landed group: one
   * confirmed batch verb, not a loop of individual retire commands, so the
   * pre-flight (every occupant idle) and the failure semantics (stop, report
   * how many succeeded) are identical on both clients.
   */
  | { type: 'desktop_worktree_retire_landed'; repoPath: string }
  /** Create a standalone worktree from a repository and source branch. */
  | { type: 'desktop_worktree_create'; repoPath: string; sourceBranch: string }
  /** Move this owner-rendered conversation into a new worktree. */
  | { type: 'desktop_worktree_convert_conversation'; tabId: string }
  | { type: 'desktop_worktree_rename'; repoPath: string; worktreePath: string; title: string }
  | { type: 'desktop_worktree_reprovision'; repoPath: string; worktreePath: string }
  /** Recreate the failed conflict merge, or reassemble when recordings recover it. */
  | { type: 'desktop_bench_recover_conflict'; repoPath: string; sourceBranch: string }
  /** Create the owner-rendered, read-only verification analysis conversation. */
  | { type: 'desktop_bench_analyse_verification'; repoPath: string; sourceBranch: string }
  | { type: 'desktop_bench_discard_member_recordings'; repoPath: string; sourceBranch: string; branchNames: string[] }
  | { type: 'desktop_bench_discard_all_recordings'; repoPath: string; sourceBranch: string }
  | { type: 'desktop_bench_add_member'; repoPath: string; sourceBranch: string; worktreePath: string; branchName: string }
  | { type: 'desktop_bench_remove_member'; repoPath: string; sourceBranch: string; worktreePath: string }
  /**
   * Retire ONE worktree (unlanded or landed). Mirrors the desktop row menu's
   * Retire verb: the renderer store owns the occupant pre-flight (idle check,
   * tab relocation) and the dirty-work appraisal, so the command routes there.
   * Refusals come back as a `retire` op result with `refusedDirty` so iOS can
   * word "refused, commit or land first" differently from a hard failure.
   */
  | { type: 'desktop_worktree_retire'; repoPath: string; worktreePath: string; branchName: string }
  /**
   * Launch the AI-assisted conflict resolution conversation for a worktree
   * whose sync/rebase stopped on conflicts (`operationState` set). Same store
   * verb as the desktop ConflictsDialog's "AI Assisted" button
   * (openConflictAssist): a fresh auto-mode conversation in the conflicted
   * directory with a fixed machine prompt and locked input. The 3-pane manual
   * merge stays desktop-only; THIS assisted path is deliberately wire-reachable
   * so a phone is never dead-ended on a conflict. Answers with a
   * `conflict_assist` op result carrying the resolver tabId.
   */
  | { type: 'desktop_worktree_conflict_assist'; repoPath: string; worktreePath: string }
  /**
   * Bench counterpart: recreate the failed assembly merge in the bench
   * (benchResolveConflict — replay recordings first; reassemble-and-finish
   * when they cover it), then launch the assisted resolver on the bench
   * directory. One command rather than two because the intermediate state
   * (merge recreated, no resolver) is not a state iOS can act on.
   */
  | { type: 'desktop_bench_conflict_assist'; repoPath: string; sourceBranch: string }
  /**
   * The full sync pipeline, remote-started: mechanical pass → AI-confirm gate
   * → sequential agents with rerere replay between → bench update-all. This is
   * the desktop's "Sync All" button verb (startWorktreePipeline), NOT the
   * mechanical-only `desktop_worktree_sync_all` above, which remains for the
   * gate-free bulk sync. Progress rides `desktop_worktree_pipeline` events;
   * the AI gate is answered with `confirm_ai` / `cancel` — money is spent only
   * after the operator's explicit confirmation, same as on the desktop.
   */
  | { type: 'desktop_worktree_pipeline_start'; repoPath: string; sourceBranch: string }
  | { type: 'desktop_worktree_pipeline_confirm_ai'; repoPath: string }
  | { type: 'desktop_worktree_pipeline_cancel'; repoPath: string }
  | { type: 'desktop_worktree_pipeline_dismiss'; repoPath: string }

/** desktop → iOS worktree/bench events. */
export type RemoteWorktreeEvent =
  | { type: 'desktop_worktree_state'; states: RemoteWorktreeState[] }
  /**
   * Live projection of the worktree sync pipeline (WorktreePipelineState).
   * Pushed on every phase/progress change while a pipeline runs, and once
   * with `phase: null` when it is dismissed. iOS renders the same banner the
   * desktop's WorktreePipelinePanel shows and raises the AI-confirm gate on
   * `awaiting-ai-confirm`. All wording (summary) is desktop-authored so every
   * client renders the same sentence.
   */
  | {
      type: 'desktop_worktree_pipeline'
      repoPath: string
      sourceBranch: string | null
      /** Null when the pipeline was dismissed (clear the banner). */
      phase: 'syncing' | 'awaiting-ai-confirm' | 'resolving' | 'assembling' | 'done' | 'failed' | null
      /** Conflicted worktree paths awaiting AI confirmation / resolution. */
      queue: string[]
      /** Worktree path the current agent is resolving, when phase=resolving. */
      current: string | null
      /** Worktree paths parked for manual resolution. */
      needsManual: string[]
      resolvedByAi: number
      /** Terminal one-line summary (done/failed), desktop-worded. */
      summary?: string
    }
  | {
      type: 'desktop_worktree_op_result'
      ok: boolean
      /** Which verb this answers, so iOS can attribute the toast. */
      operation: 'open' | 'sync' | 'land_and_retire' | 'assemble' | 'update' | 'update_all' | 'sync_all' | 'retire' | 'retire_all' | 'create' | 'convert' | 'rename' | 'reprovision' | 'recover_conflict' | 'conflict_assist' | 'analyse_verification' | 'discard_recordings' | 'pipeline_start'
      error?: string
      /** Tab opened or focused for an `open` result. */
      tabId?: string
      /** Distinguishes a refusal the operator can fix from a hard failure. */
      refusedDirty?: boolean
      hasConflicts?: boolean
      /**
       * Non-blocking collision prediction from the pin-update dry-run. The
       * operation SUCCEEDED; the warning says the next assembly will conflict.
       */
      warning?: string
      /**
       * Per-worktree counts for `sync_all`, pre-worded by the desktop so every
       * client renders the same sentence. Absent on the single-target verbs.
       */
      summary?: string
      /**
       * Recovery ref created when a forced retire preserved uncommitted work.
       * Absent when the worktree was clean. Only set for `retire`.
       */
      recoveryRef?: string
      /**
       * `retire_all`'s count of worktrees actually retired before it stopped —
       * either at the end (`ok`) or at the first failure (partial, `!ok`).
       */
      retired?: number
      /**
       * Bench directories removed because disenrolling left them with no members.
       * Set for `land` and `retire`; absent when no bench was pruned.
       */
      prunedBenchPaths?: string[]
    }
