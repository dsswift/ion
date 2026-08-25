import { ipcRenderer } from 'electron'
import { IPC } from '../shared/types'
import { legacyReviewToStage } from '../shared/types-git'
import type { IonAPI } from './ionapi'

/** Worktree and integration-bench methods exposed to the renderer. */
export const worktreeApi = {
  // ─── Git worktree operations ───
  gitWorktreeAdd: (repoPath, sourceBranch) => ipcRenderer.invoke(IPC.GIT_WORKTREE_ADD, { repoPath, sourceBranch }),
  gitWorktreeRemove: (repoPath, worktreePath, branchName, force) => ipcRenderer.invoke(IPC.GIT_WORKTREE_REMOVE, { repoPath, worktreePath, branchName, force }),
  gitWorktreeList: (repoPath) => ipcRenderer.invoke(IPC.GIT_WORKTREE_LIST, { repoPath }),
  gitWorktreeStatus: (worktreePath, sourceBranch) => ipcRenderer.invoke(IPC.GIT_WORKTREE_STATUS, { worktreePath, sourceBranch }),
  gitWorktreeMerge: (repoPath, worktreeBranch, sourceBranch, noFf) => ipcRenderer.invoke(IPC.GIT_WORKTREE_MERGE, { repoPath, worktreeBranch, sourceBranch, noFf }),
  gitWorktreePush: (worktreePath, sourceBranch) => ipcRenderer.invoke(IPC.GIT_WORKTREE_PUSH, { worktreePath, sourceBranch }),
  gitWorktreeRebase: (worktreePath, sourceBranch) => ipcRenderer.invoke(IPC.GIT_WORKTREE_REBASE, { worktreePath, sourceBranch }),
  gitWorktreeLandAndRetire: (args) => ipcRenderer.invoke(IPC.GIT_WORKTREE_LAND_AND_RETIRE, args),
  gitWorktreeSync: (worktreePath, sourceBranch) => ipcRenderer.invoke(IPC.GIT_WORKTREE_SYNC, { worktreePath, sourceBranch }),
  gitWorktreeSyncAll: (repoPath) => ipcRenderer.invoke(IPC.GIT_WORKTREE_SYNC_ALL, { repoPath }),
  gitWorktreeBaseStatus: (worktreePath, sourceBranch) => ipcRenderer.invoke(IPC.GIT_WORKTREE_BASE_STATUS, { worktreePath, sourceBranch }),
  gitWorktreeInventory: (repoPath) => ipcRenderer.invoke(IPC.GIT_WORKTREE_INVENTORY, { repoPath }),
  gitWorktreeSeedTitle: (worktreePath, title) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_SEED_TITLE, { worktreePath, title }),
  gitWorktreeSetTitle: (args) => ipcRenderer.invoke(IPC.GIT_WORKTREE_SET_TITLE, args),
  gitWorktreeSetStage: (args) => ipcRenderer.invoke(IPC.GIT_WORKTREE_SET_STAGE, args),
  // Deprecated shim over gitWorktreeSetStage — see the ionapi.ts declaration
  // for the removal condition. The verdict→stage mapping is the shared
  // legacyReviewToStage table, the same one the workspaces-file load
  // migration uses, so the two cannot drift. `sourceBranch` is ignored:
  // stages are worktree-scoped.
  benchSetReview: (args) => ipcRenderer.invoke(IPC.GIT_WORKTREE_SET_STAGE, {
    worktreePath: args.worktreePath,
    repoPath: args.repoPath,
    stage: legacyReviewToStage(args.review) ?? null,
  }),
  benchList: (repoPath) => ipcRenderer.invoke(IPC.BENCH_LIST, { repoPath }),
  benchResolvePath: (directory) => ipcRenderer.invoke(IPC.BENCH_RESOLVE_PATH, { directory }),
  benchEnsure: (repoPath, sourceBranch) => ipcRenderer.invoke(IPC.BENCH_ENSURE, { repoPath, sourceBranch }),
  benchAddMember: (args) => ipcRenderer.invoke(IPC.BENCH_ADD_MEMBER, args),
  benchRemoveMember: (args) => ipcRenderer.invoke(IPC.BENCH_REMOVE_MEMBER, args),
  gitWorktreeRegistration: (worktreePath) => ipcRenderer.invoke(IPC.GIT_WORKTREE_REGISTRATION, { worktreePath }),
  benchSetOrder: (args) => ipcRenderer.invoke(IPC.BENCH_SET_ORDER, args),
  benchUpdateMember: (args) => ipcRenderer.invoke(IPC.BENCH_UPDATE_MEMBER, args),
  benchUpdateAll: (repoPath, sourceBranch) => ipcRenderer.invoke(IPC.BENCH_UPDATE_ALL, { repoPath, sourceBranch }),
  benchAssemble: (repoPath, sourceBranch) => ipcRenderer.invoke(IPC.BENCH_ASSEMBLE, { repoPath, sourceBranch }),
  benchResolveConflict: (repoPath, sourceBranch) => ipcRenderer.invoke(IPC.BENCH_RESOLVE_CONFLICT, { repoPath, sourceBranch }),
  benchRerereCount: (directory) => ipcRenderer.invoke(IPC.BENCH_RERERE_COUNT, { directory }),
  benchRerereForget: (directory, paths) => ipcRenderer.invoke(IPC.BENCH_RERERE_FORGET, { directory, paths }),
  benchRerereDiscardAll: (directory) => ipcRenderer.invoke(IPC.BENCH_RERERE_DISCARD_ALL, { directory }),
  benchPrepareVerificationAnalysis: (repoPath, sourceBranch) =>
    ipcRenderer.invoke(IPC.BENCH_PREPARE_VERIFICATION_ANALYSIS, { repoPath, sourceBranch }),
  benchDiscardMemberRecordings: (repoPath, sourceBranch, branchNames) =>
    ipcRenderer.invoke(IPC.BENCH_DISCARD_MEMBER_RECORDINGS, { repoPath, sourceBranch, branchNames }),
  openWorktreeOverlap: (context) => ipcRenderer.send(IPC.WORKTREE_OVERLAP_OPEN, context),
  getWorktreeOverlapContext: () => ipcRenderer.invoke(IPC.WORKTREE_OVERLAP_CONTEXT),
  getWorktreeOverlap: (basis) => ipcRenderer.invoke(IPC.WORKTREE_OVERLAP_ANALYZE, basis),
  previewWorktreeOverlap: (basis, paths) => ipcRenderer.invoke(IPC.WORKTREE_OVERLAP_PREVIEW, basis, paths),
  previewWorktreeOverlapApply: (basis, paths) => ipcRenderer.invoke(IPC.WORKTREE_OVERLAP_APPLY_PREVIEW, basis, paths),
  applyWorktreeOverlap: (basis, paths) => ipcRenderer.invoke(IPC.WORKTREE_OVERLAP_APPLY, basis, paths),
  solveWorktreeOverlap: (basis, keptPaths) => ipcRenderer.invoke(IPC.WORKTREE_OVERLAP_SOLVE, basis, keptPaths),
  autoOrderWorktreeOverlap: (basis, paths) => ipcRenderer.invoke(IPC.WORKTREE_OVERLAP_AUTO_ORDER, basis, paths),
  benchRefreshStaleness: (repoPath, sourceBranch) => ipcRenderer.invoke(IPC.BENCH_REFRESH_STALENESS, { repoPath, sourceBranch }),
  benchReconcileResolution: (directory) => ipcRenderer.invoke(IPC.BENCH_RECONCILE_RESOLUTION, { directory }),
  gitWorktreeAppraise: (worktreePath, sourceBranch) => ipcRenderer.invoke(IPC.GIT_WORKTREE_APPRAISE, { worktreePath, sourceBranch }),
  gitWorktreeRetirePreview: (worktreePath) => ipcRenderer.invoke(IPC.GIT_WORKTREE_RETIRE_PREVIEW, { worktreePath }),
  gitWorktreeReprovision: (args) => ipcRenderer.invoke(IPC.GIT_WORKTREE_REPROVISION, args),
  gitWorktreeReattach: (args) => ipcRenderer.invoke(IPC.GIT_WORKTREE_REATTACH, args),

} satisfies Partial<IonAPI>
