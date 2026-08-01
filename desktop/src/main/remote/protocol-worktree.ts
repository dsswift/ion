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
   * unenrolled worktree -- which is a different fact from `enabled: false`
   * (enrolled but skipped), and clients must render them differently.
   */
  membership?: RemoteMembership
}

/**
 * One worktree's bench membership, as iOS sees it. Mirrors WorktreeMembership.
 *
 * Carries NO worktree fields. This used to be a whole `RemoteBenchMember` that
 * re-sent `worktreePath`, `branchName`, `label`, and a `title` the desktop had
 * to resolve by joining against the inventory -- so the wire shipped one
 * worktree twice, in two shapes, and iOS rendered it in two different rows.
 * Membership now decorates the worktree it belongs to.
 *
 * The three axes ship separately for the same reason they are stored
 * separately: a member can be excluded AND behind AND conflicted, and the old
 * single `status` could report only one of those.
 */
export interface RemoteMembership {
  /** Which bench: the source branch it integrates into. */
  sourceBranch: string
  enabled: boolean
  pin: 'empty' | 'current' | 'behind' | 'absorbed' | 'gone'
  merge: 'unbuilt' | 'merged' | 'conflicted' | 'skipped'
  /** Operator verdict on the current pin. Absent means unreviewed. */
  review?: 'good' | 'issue'
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
  /** True when the feature branch has moved past the bench's base. */
  baseDrifted: boolean
  /** Conversations open in the bench directory, in tab order. */
  openConversations: RemoteOpenConversation[]
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
  | { type: 'desktop_worktree_land'; repoPath: string; worktreePath: string; worktreeBranch: string; sourceBranch: string }
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
  | { type: 'desktop_bench_set_enabled'; repoPath: string; sourceBranch: string; worktreePath: string; enabled: boolean }
  | { type: 'desktop_bench_set_review'; repoPath: string; sourceBranch: string; worktreePath: string; review: 'good' | 'issue' | null }
  | { type: 'desktop_bench_reorder_member'; repoPath: string; sourceBranch: string; worktreePath: string; toIndex: number }
  | { type: 'desktop_bench_add_member'; repoPath: string; sourceBranch: string; worktreePath: string; branchName: string }
  | { type: 'desktop_bench_remove_member'; repoPath: string; sourceBranch: string; worktreePath: string }

/** desktop → iOS worktree/bench events. */
export type RemoteWorktreeEvent =
  | { type: 'desktop_worktree_state'; states: RemoteWorktreeState[] }
  | {
      type: 'desktop_worktree_op_result'
      ok: boolean
      /** Which verb this answers, so iOS can attribute the toast. */
      operation: 'sync' | 'land' | 'assemble' | 'update' | 'update_all'
      error?: string
      /** Distinguishes a refusal the operator can fix from a hard failure. */
      refusedDirty?: boolean
      hasConflicts?: boolean
      /**
       * Non-blocking collision prediction from the pin-update dry-run. The
       * operation SUCCEEDED; the warning says the next assembly will conflict.
       */
      warning?: string
    }
