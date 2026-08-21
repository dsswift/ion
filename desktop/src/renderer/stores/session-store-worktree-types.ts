/**
 * session-store-worktree-types — worktree, bench, and conflict-alert action
 * signatures, split from session-store-types.ts (file-size cap).
 *
 * These are genuinely one cohesive concern: every action here mutates a
 * worktree's on-disk state, a bench's shared assembly, or the conflict-alert
 * bookkeeping those two surfaces raise. `State` extends this interface
 * (session-store-types.ts) so every existing call site keeps working
 * unchanged — this is purely a file-organization split, not a behavior or
 * type-shape change.
 */
import type { GitConflictAlert } from './session-store-aux-types'
import type { WorktreeProvisionState, WorkStage, BenchAssembleResult, WorktreeMoveResult, LandAndRetireResult } from '../../shared/types'

export interface WorktreeBenchActions {
  setupWorktree: (tabId: string, sourceBranch: string, setAsDefault: boolean) => Promise<void>
  /** Create a standalone worktree for a repository source branch. */
  createWorktree: (repoPath: string, sourceBranch: string) => Promise<{ ok: boolean; worktreePath?: string; error?: string }>
  convertToWorktree: (tabId: string) => Promise<{ ok: boolean; error?: string }>
  cancelWorktreeSetup: (tabId: string) => void
  /**
   * Rename a conversation AND the worktree it lives in, to the same name.
   *
   * The one path that changes both. Ordinary renames are independent by design
   * (a worktree's topic does not follow every relabelling of a conversation in
   * it), so this exists as an explicit operator verb rather than a heuristic.
   */
  renameTabAndWorktree: (tabId: string, title: string) => Promise<void>
  /** Change the title of one worktree without changing any conversation title. */
  renameWorktree: (repoPath: string, worktreePath: string, title: string) => Promise<{ ok: boolean; error?: string }>
  finishWorktreeTab: (tabId: string, strategyOverride?: 'merge-ff' | 'merge' | 'pr') => Promise<void>
  /** Terminal completion: merge the worktree, remove it, and close its finished conversations. */
  landAndRetireWorktree: (
    repoPath: string,
    entry: { worktreePath: string; branchName: string; sourceBranch: string; title?: string; label: string },
    strategyOverride?: 'merge-ff' | 'merge' | 'pr',
  ) => Promise<LandAndRetireResult>
  setWorktreeUncommitted: (tabId: string, hasChanges: boolean) => void
  refreshWorktreeInventory: (repoPath: string) => Promise<void>
  /**
   * Re-read both worktree surfaces (inventory + bench) for a repo.
   *
   * The pair, named once, for any flow that changes git state a worktree row
   * describes — the row is a join of the two caches, so refreshing one leaves a
   * half-stale row. Never reassembles; refreshing reads, assembly mutates.
   */
  refreshWorkspaceViews: (repoPath: string) => Promise<void>
  /** Seal every existing conversation in a landed worktree for read-only review. */
  sealLandedWorktree: (worktreePath: string) => Promise<void>
  /** Open (or focus) a conversation in an existing worktree. */
  openWorktreeConversation: (worktreePath: string) => Promise<string>
  /**
   * Create an ADDITIONAL conversation in a worktree, with its worktree metadata
   * attached. Distinct from `openWorktreeConversation`, which focuses or cycles
   * the ones that already exist.
   */
  newWorktreeConversation: (worktreePath: string) => Promise<string>
  syncWorktree: (worktreePath: string, sourceBranch: string, repoPath: string) => Promise<{ ok: boolean; error?: string; hasConflicts?: boolean; refusedDirty?: boolean; replayed?: boolean }>
  /**
   * Phase 1 of the sync-all pipeline: the free mechanical pass over every
   * worktree of the repo. Pauses at `awaiting-ai-confirm` when conflicts
   * survive it — agents cost money, so launching them is the operator's
   * explicit act (confirmWorktreePipelineAi) — and runs straight through to
   * the bench phase when none do. See stores/slices/worktree-pipeline-slice.ts.
   */
  startWorktreePipeline: (repoPath: string, sourceBranch?: string | null) => Promise<void>
  /** The confirm gate's Yes: sequential AI escalation with rerere replay between agents. */
  confirmWorktreePipelineAi: () => Promise<void>
  /** Stop between steps; never aborts an in-flight rebase or a running agent. */
  cancelWorktreePipeline: () => void
  /** Clear the finished pipeline banner. */
  dismissWorktreePipeline: () => void
  /** Internal legacy cleanup for worktrees landed before terminal completion shipped. */
  retireWorktree: (repoPath: string, worktreePath: string, branchName: string) => Promise<WorktreeMoveResult>
  /** Retire every worktree already sealed by a successful Land. The batch
   * preflights all current occupants before deleting any checkout. */
  retireLandedWorktrees: (repoPath: string) => Promise<{ ok: boolean; retired: number; error?: string }>
  /**
   * Re-run provisioning for a worktree whose dependency state looks wrong
   * (missing node_modules, a half-finished install). Same path creation uses.
   */
  reprovisionWorktree: (repoPath: string, worktreePath: string) => Promise<{ ok: boolean; state: WorktreeProvisionState; error?: string }>
  refreshBench: (repoPath: string) => Promise<void>
  /** Open (or focus) a conversation in the bench worktree. */
  openBenchConversation: (repoPath: string, sourceBranch: string) => Promise<string | null>
  /**
   * Cycle to the next already-open conversation in this bench, relative to
   * the owner's currently focused tab. Distinct from openBenchConversation,
   * which additionally creates the persistent singleton on first open — this
   * is the bar's repeated "cycle" control for an already-open bench.
   */
  cycleBenchConversation: (repoPath: string, sourceBranch: string) => void
  /**
   * Open (or focus) the bench's ONE dedicated terminal tab, building the bench
   * first when its directory is not there. Returns the tab id, or null when the
   * workspace is unknown or the build failed.
   */
  openBenchTerminal: (repoPath: string, sourceBranch: string) => Promise<string | null>
  benchAssemble: (repoPath: string, sourceBranch: string) => Promise<BenchAssembleResult>
  /**
   * Resolve-once: prepare the failed assembly merge in the bench (left in
   * progress for the ConflictsDialog), or reassemble immediately when
   * recordings already cover the conflict. Returns the bench path to open the
   * dialog on, or null when nothing needed resolving / preparation failed.
   */
  benchResolveConflict: (repoPath: string, sourceBranch: string) => Promise<string | null>
  benchRerereCount: (directory: string) => Promise<number>
  benchRerereForget: (directory: string, paths: string[]) => Promise<number>
  benchRerereDiscardAll: (directory: string) => Promise<number>
  /**
   * AI-assisted analysis of a bench verification failure (never a fix — see
   * git-conflict-slice.ts's openConflictAssist for the parallel conflict-fix
   * flow this deliberately does NOT mirror on mode). ONE forwarded action:
   * materialises the failing tree back into the bench, then opens a
   * plan-mode, input-locked conversation there whose only job is to name
   * whether the failure is a poisoned recording or a genuine cross-member
   * incompatibility. Throws with a remediation message when the `standard`
   * model tier is not configured, or when the diagnostic tree could not be
   * rebuilt (the bench state moved since the failure).
   */
  openBenchVerificationAnalysis: (repoPath: string, sourceBranch: string) => Promise<string>
  /** Forget recordings for selected bench members, then reassemble unchanged pins. */
  benchDiscardMemberRecordings: (
    repoPath: string, sourceBranch: string, branchNames: string[],
  ) => Promise<BenchAssembleResult & { forgottenCount?: number; branchesWithNothingToForget?: string[] }>
  benchUpdateMember: (repoPath: string, sourceBranch: string, worktreePath: string) => Promise<BenchAssembleResult>
  benchUpdateAll: (repoPath: string, sourceBranch: string) => Promise<BenchAssembleResult>
  /** Apply a confirmed overlap fast lane atomically, without assembling it. */
  benchApplyOverlapFastLane: (repoPath: string, sourceBranch: string, basis: import('../../shared/types-worktree-overlap').WorktreeOverlapBasis, orderedPaths: string[]) => Promise<import('../../shared/types-worktree-overlap').WorktreeOverlapApplyResult>
  benchAddMember: (repoPath: string, sourceBranch: string, worktreePath: string, branchName: string) => Promise<{ ok: boolean; error?: string }>
  benchRemoveMember: (repoPath: string, sourceBranch: string, worktreePath: string) => Promise<void>
  /** Set or clear the operator's workflow stage on a worktree. `null` clears. */
  setWorktreeStage: (repoPath: string, worktreePath: string, stage: WorkStage | null) => Promise<void>
  /**
   * @deprecated Compatibility shim over `setWorktreeStage` for call sites that
   * predate the work-stage system (`good` → `verified`, `issue` → `bug`,
   * `null` clears; `sourceBranch` ignored — stages are worktree-scoped).
   * Removable once every sibling branch has migrated to `setWorktreeStage`:
   * wt/ion-98d550f3, wt/ion-d2101138, wt/ion-c151d648, wt/ion-02804dd4.
   */
  benchSetReview: (repoPath: string, sourceBranch: string, worktreePath: string, review: 'good' | 'issue' | null) => Promise<void>
  benchSetOrder: (repoPath: string, sourceBranch: string, worktreePath: string, toIndex: number) => Promise<void>
  /** Dismiss the absorbed-into-base notice for one workspace. */
  clearBenchRetired: (repoPath: string, sourceBranch: string) => void
  /** Record a conflicted directory (sync/land failure or detected mid-operation). */
  recordConflictAlert: (directory: string, alert: Omit<GitConflictAlert, 'dismissed' | 'recordedAt'>) => void
  /** Drop a directory's conflict alert — its operation completed or aborted. */
  clearConflictAlert: (directory: string) => void
  /** Hide the toast for a directory; the badge stays until actually resolved. */
  dismissConflictAlert: (directory: string) => void
  /** Open (or focus) a conversation in the conflicted directory and submit the assist prompt. */
  openConflictAssist: (directory: string) => Promise<string>
  /** Continue a completed conflict resolution in the owner, then refresh its workspace views. */
  continueConflictOperation: (directory: string) => Promise<{ ok: boolean; error?: string }>
  /** Abort a conflict operation in the owner, then refresh its workspace views. */
  abortConflictOperation: (directory: string) => Promise<{ ok: boolean; error?: string }>
}
