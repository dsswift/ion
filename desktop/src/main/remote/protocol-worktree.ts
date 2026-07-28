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

/** One worktree, as iOS sees it. Mirrors WorktreeInventoryEntry. */
export interface RemoteWorktree {
  worktreePath: string
  branchName: string
  label: string
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
  /** Tab id when a conversation is already open here, so iOS focuses it. */
  openTabId?: string
}

/** One bench member, as iOS sees it. Mirrors IntegrationMember. */
export interface RemoteBenchMember {
  worktreePath: string
  branchName: string
  label: string
  enabled: boolean
  /** Short sha of the contribution currently integrated. */
  pinnedSha: string
  status: 'integrated' | 'pending' | 'landed' | 'stale' | 'conflicted' | 'missing' | 'excluded'
  conflictPaths?: string[]
  conflictsWith?: string[]
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
  /** Tab id when a bench conversation is already open. */
  openTabId?: string
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
