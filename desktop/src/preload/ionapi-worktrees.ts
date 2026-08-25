/**
 * The IonAPI contextBridge surface type, extracted from preload/index.ts to
 * keep that file under the 600-line cap. index.ts implements this interface and
 * re-exports it (renderer/env.d.ts imports it from ../preload/index).
 */
import type {
  WorktreeInfo,
  WorktreeStatus,
  LandResult,
  SyncAllResult,
  WorktreeMoveResult,
  WorktreeInventoryEntry,
  WorktreeAppraisalWire,
  WorktreeProvisionState,
  WorkStage,
  IntegrationWorkspace,
  BenchAssembleResult,
} from "../shared/types";
import type {} from "../shared/types-ipc";
import type {} from "../shared/types-automation";

export interface IonWorktreesApi {
  // ─── Git worktree operations ───
  gitWorktreeAdd(
    repoPath: string,
    sourceBranch: string,
  ): Promise<{ ok: boolean; worktree?: WorktreeInfo; error?: string }>;
  gitWorktreeDiscard(args: {
    repoPath: string;
    worktreePath: string;
    branchName: string;
    sourceBranch: string;
  }): Promise<WorktreeMoveResult>;
  gitWorktreeList(repoPath: string): Promise<{
    worktrees: Array<{ path: string; branch: string; head: string }>;
  }>;
  gitWorktreeStatus(
    worktreePath: string,
    sourceBranch: string,
  ): Promise<WorktreeStatus>;
  gitWorktreeMerge(
    repoPath: string,
    worktreeBranch: string,
    sourceBranch: string,
    noFf?: boolean,
  ): Promise<{ ok: boolean; error?: string; hasConflicts?: boolean }>;
  gitWorktreePush(
    worktreePath: string,
    sourceBranch: string,
  ): Promise<{
    ok: boolean;
    error?: string;
    remoteBranch?: string;
    remoteUrl?: string;
  }>;
  gitWorktreeRebase(
    worktreePath: string,
    sourceBranch: string,
  ): Promise<{ ok: boolean; error?: string; hasConflicts?: boolean }>;
  /**
   * Worktree lifecycle verbs. `landAndRetire` integrates a clean worktree and
   * then removes it and its branch in one step; `reattach` returns the
   * directory the caller should relocate the conversation into (see
   * relocateTabSession).
   */
  gitWorktreeLandAndRetire(args: {
    repoPath: string;
    worktreePath: string;
    worktreeBranch: string;
    branchName?: string;
    sourceBranch: string;
    noFf?: boolean;
    syncFirst?: boolean;
    requireFastForward?: boolean;
  }): Promise<LandResult & { landed?: boolean; workingDirectory?: string }>;
  gitWorktreeSync(
    worktreePath: string,
    sourceBranch: string,
  ): Promise<{
    ok: boolean;
    error?: string;
    hasConflicts?: boolean;
    refusedDirty?: boolean;
    replayed?: boolean;
    dropped?: number;
    warning?: string;
  }>;
  /**
   * Bulk sync: every managed worktree of a repo, sequentially, with rerere
   * replay between them. The mechanical half of the sync-all pipeline — it
   * never opens conversations or spends tokens.
   */
  gitWorktreeSyncAll(repoPath: string): Promise<SyncAllResult>;
  /** Every managed worktree for a repo, with state for describing and acting on it. */
  gitWorktreeInventory(
    repoPath: string,
  ): Promise<{ worktrees: WorktreeInventoryEntry[] }>;
  /**
   * Seed a worktree's name with a title the renderer already generated for the
   * conversation running inside it.
   *
   * A recording, not a generation — the string is produced once, by the tab
   * titling path, so the two names cannot diverge. Fire-and-forget from the
   * renderer's point of view: the main process decides whether the directory is
   * a worktree at all and whether it is already named (first prompt wins), and
   * the answer comes back as a no-op reason.
   */
  gitWorktreeSeedTitle(
    worktreePath: string,
    title: string,
  ): Promise<{
    ok: boolean;
    title?: string;
    reason?: "empty-input" | "not-a-worktree" | "already-titled";
  }>;
  /** Operator override for a worktree's title. */
  gitWorktreeSetTitle(args: {
    worktreePath: string;
    repoPath?: string;
    title: string;
  }): Promise<{ ok: boolean; title?: string; error?: string }>;
  /** Set or clear the operator's workflow stage on a worktree. `null` clears. */
  gitWorktreeSetStage(args: {
    worktreePath: string;
    repoPath?: string;
    stage: WorkStage | null;
  }): Promise<{ ok: boolean; stage?: WorkStage | null; error?: string }>;
  /**
   * @deprecated Compatibility shim over `gitWorktreeSetStage` for callers that
   * predate the work-stage system: `good` maps to `verified`, `issue` to
   * `bug`, `null` clears (the shared `legacyReviewToStage` table). The
   * `sourceBranch` argument is accepted and ignored — stages are
   * worktree-scoped, not bench-scoped. Removable once every sibling branch
   * has migrated to `gitWorktreeSetStage`; as of this writing the unmigrated
   * callers are wt/ion-98d550f3, wt/ion-d2101138, wt/ion-c151d648, and
   * wt/ion-02804dd4 (WorktreeRowMenu.tsx).
   */
  benchSetReview(args: {
    repoPath: string;
    sourceBranch: string;
    worktreePath: string;
    review: "good" | "issue" | null;
  }): Promise<{ ok: boolean; error?: string }>;
  /** What would be lost if this worktree were removed right now. */
  gitWorktreeAppraise(
    worktreePath: string,
    sourceBranch: string,
  ): Promise<WorktreeAppraisalWire>;
  // ── Integration workspace (the bench) ──
  benchList(repoPath: string): Promise<{
    workspaces: IntegrationWorkspace[];
    tips: Record<string, string>;
  }>;
  /** Resolve a bench root or descendant to its persisted owning workspace. */
  benchResolvePath(
    directory: string,
  ): Promise<{ workspace: IntegrationWorkspace | null }>;
  benchEnsure(
    repoPath: string,
    sourceBranch: string,
  ): Promise<{ workspace: IntegrationWorkspace }>;
  benchAddMember(args: {
    repoPath: string;
    sourceBranch: string;
    worktreePath: string;
    branchName: string;
  }): Promise<{
    ok: boolean;
    error?: string;
    workspace?: IntegrationWorkspace;
  }>;
  benchRemoveMember(args: {
    repoPath: string;
    sourceBranch: string;
    worktreePath: string;
  }): Promise<{ workspace: IntegrationWorkspace | null }>;
  /**
   * The registry's record for a worktree. The authoritative answer for which
   * repo owns it -- never derive that from the renderer's inventory cache, which
   * is keyed by whatever path the panel last queried.
   */
  gitWorktreeRegistration(worktreePath: string): Promise<{
    registration: {
      repoPath: string;
      branchName: string;
      sourceBranch: string | null;
      title: string | null;
      landedAt?: number;
    } | null;
  }>;
  benchSetOrder(args: {
    repoPath: string;
    sourceBranch: string;
    worktreePath: string;
    toIndex: number;
  }): Promise<{ workspace: IntegrationWorkspace | null }>;
  benchUpdateMember(args: {
    repoPath: string;
    sourceBranch: string;
    worktreePath: string;
  }): Promise<BenchAssembleResult>;
  benchUpdateAll(
    repoPath: string,
    sourceBranch: string,
  ): Promise<BenchAssembleResult>;
  benchAssemble(
    repoPath: string,
    sourceBranch: string,
  ): Promise<BenchAssembleResult>;
  /**
   * Re-create the failed assembly merge in the bench and leave it in progress
   * so the ConflictsDialog can resolve it once (rerere records the resolution).
   * `branchName` names the conflicted member when a merge was left open;
   * absent when everything now merges cleanly (recordings already cover it).
   */
  benchResolveConflict(
    repoPath: string,
    sourceBranch: string,
  ): Promise<{
    ok: boolean;
    benchPath?: string;
    branchName?: string;
    error?: string;
  }>;
  benchRerereCount(
    directory: string,
  ): Promise<{ ok: boolean; count: number; error?: string }>;
  benchRerereForget(
    directory: string,
    paths: string[],
  ): Promise<{ ok: boolean; count: number; error?: string }>;
  benchRerereDiscardAll(
    directory: string,
  ): Promise<{ ok: boolean; count: number; error?: string }>;
  /**
   * Rebuild the failing tree from a verification failure back into the bench,
   * verified fresh, for the AI-assisted analysis conversation to read. Does
   * NOT wipe on completion — that is the point. Refuses when the bench state
   * has moved since the failure (a pin changed, a recording was forgotten).
   */
  benchPrepareVerificationAnalysis(
    repoPath: string,
    sourceBranch: string,
  ): Promise<{ ok: boolean; benchPath?: string; error?: string }>;
  /** Forget recordings for selected bench members, then reassemble unchanged pins. */
  benchDiscardMemberRecordings(
    repoPath: string,
    sourceBranch: string,
    branchNames: string[],
  ): Promise<
    BenchAssembleResult & {
      forgottenCount?: number;
      branchesWithNothingToForget?: string[];
    }
  >;
  benchRefreshStaleness(
    repoPath: string,
    sourceBranch: string,
  ): Promise<{ workspace: IntegrationWorkspace | null }>;
  /** Clear a member's resolved conflict verdict after a proven bench merge. */
  benchReconcileResolution(directory: string): Promise<{ reconciled: boolean }>;
  /** Open the desktop-only graphical overlap view for a repository. */
  openWorktreeOverlap(context: {
    repoPath: string;
    sourceBranch?: string;
  }): void;
  getWorktreeOverlapContext(): Promise<{
    repoPath: string;
    sourceBranch?: string;
  } | null>;
  getWorktreeOverlap(
    basis: import("../shared/types-worktree-overlap").WorktreeOverlapBasis,
  ): Promise<{
    analysis?: import("../shared/types-worktree-overlap").WorktreeOverlapAnalysis;
    error?: string;
  }>;
  previewWorktreeOverlap(
    basis: import("../shared/types-worktree-overlap").WorktreeOverlapBasis,
    paths: string[],
  ): Promise<{
    preview?: import("../shared/types-worktree-overlap").WorktreeOverlapPreview;
    error?: string;
  }>;
  previewWorktreeOverlapApply(
    basis: import("../shared/types-worktree-overlap").WorktreeOverlapBasis,
    paths: string[],
  ): Promise<{
    preview?: import("../shared/types-worktree-overlap").WorktreeOverlapApplyPreview;
    error?: string;
  }>;
  applyWorktreeOverlap(
    basis: import("../shared/types-worktree-overlap").WorktreeOverlapBasis,
    paths: string[],
  ): Promise<
    import("../shared/types-worktree-overlap").WorktreeOverlapApplyResult
  >;
  solveWorktreeOverlap(
    basis: import("../shared/types-worktree-overlap").WorktreeOverlapBasis,
    keptPaths: string[],
  ): Promise<{
    solver?: import("../shared/types-worktree-overlap").WorktreeOverlapSolverResult;
    error?: string;
  }>;
  autoOrderWorktreeOverlap(
    basis: import("../shared/types-worktree-overlap").WorktreeOverlapBasis,
    paths: string[],
  ): Promise<{
    cohort?: import("../shared/types-worktree-overlap").WorktreeOverlapCohort;
    error?: string;
  }>;
  /** Base staleness: has the feature branch moved ahead of this worktree? */
  gitWorktreeBaseStatus(
    worktreePath: string,
    sourceBranch: string,
  ): Promise<{
    behindCount: number;
    behindSubjects: string[];
    needsSync: boolean;
    hasUncommittedChanges: boolean;
    appraisalFailed?: boolean;
  }>;
  /**
   * Read-only preview of a retire's blast radius: the bench directories the
   * retire would remove because disenrolling this worktree empties them.
   *
   * Asked BEFORE the retire so the caller can refuse when a conversation living
   * in one of those directories is still active. Mutates nothing.
   */
  gitWorktreeRetirePreview(
    worktreePath: string,
  ): Promise<{ prunedBenchPaths: string[] }>;
  /**
   * Re-run provisioning for a worktree whose dependency state looks wrong.
   * Same code path as creation, so a repair cannot drift from a fresh provision.
   */
  gitWorktreeReprovision(args: {
    repoPath: string;
    worktreePath: string;
  }): Promise<{ ok: boolean; state: WorktreeProvisionState; error?: string }>;
  gitWorktreeReattach(args: {
    repoPath: string;
    sourceBranch: string;
    title?: string;
  }): Promise<WorktreeMoveResult>;
}
