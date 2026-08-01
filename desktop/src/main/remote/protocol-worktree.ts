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
}

/** One bench member, as iOS sees it. Mirrors IntegrationMember. */
export interface RemoteBenchMember {
  worktreePath: string
  branchName: string
  label: string
  /**
   * The member worktree's human title, resolved from the worktree inventory.
   * Absent until the worktree has been named. Never stored on the member record
   * itself -- one worktree, one title, no second copy to drift.
   */
  title?: string
  enabled: boolean
  /** Short sha of the contribution currently integrated. */
  pinnedSha: string
  status: 'integrated' | 'pending' | 'landed' | 'stale' | 'conflicted' | 'missing' | 'excluded'
  conflictPaths?: string[]
  conflictsWith?: string[]
  /** Conversations open in the MEMBER's worktree (not in the bench). */
  openConversations: RemoteOpenConversation[]
}

/** One integration workspace, as iOS sees it. */
export interface RemoteBench {
  repoPath: string
  sourceBranch: string
  benchPath: string
  benchBranch: string
  members: RemoteBenchMember[]
  baseSha: string
  lastBuiltAt: number
  /** True when the feature branch has moved past the bench's base. */
  baseDrifted: boolean
  /** Conversations open in the bench directory, in tab order. */
  openConversations: RemoteOpenConversation[]
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
  | { type: 'desktop_worktree_open_conversation'; worktreePath: string }
  | { type: 'desktop_worktree_sync'; worktreePath: string; sourceBranch: string; repoPath: string }
  | { type: 'desktop_worktree_land'; repoPath: string; worktreePath: string; worktreeBranch: string; sourceBranch: string }
  | { type: 'desktop_bench_open_conversation'; repoPath: string; sourceBranch: string }
  | { type: 'desktop_bench_rebuild'; repoPath: string; sourceBranch: string }
  | { type: 'desktop_bench_update_member'; repoPath: string; sourceBranch: string; worktreePath: string }
  | { type: 'desktop_bench_update_all'; repoPath: string; sourceBranch: string }
  | { type: 'desktop_bench_set_enabled'; repoPath: string; sourceBranch: string; worktreePath: string; enabled: boolean }
  | { type: 'desktop_bench_add_member'; repoPath: string; sourceBranch: string; worktreePath: string; branchName: string }
  | { type: 'desktop_bench_remove_member'; repoPath: string; sourceBranch: string; worktreePath: string }

/** desktop → iOS worktree/bench events. */
export type RemoteWorktreeEvent =
  | { type: 'desktop_worktree_state'; states: RemoteWorktreeState[] }
  | {
      type: 'desktop_worktree_op_result'
      ok: boolean
      /** Which verb this answers, so iOS can attribute the toast. */
      operation: 'sync' | 'land' | 'rebuild' | 'update' | 'update_all'
      error?: string
      /** Distinguishes a refusal the operator can fix from a hard failure. */
      refusedDirty?: boolean
      hasConflicts?: boolean
    }
