/**
 * Git and git-worktree/bench IPC bridge, extracted from preload/index.ts to
 * keep that file under the repo file-size cap.
 *
 * `gitApi` is spread into the main `api` object in index.ts. It is typed as
 * `Pick<IonAPI, ...>` rather than its own hand-authored interface so the
 * method signatures here can never drift from the single canonical
 * declaration in ionapi.ts — that file is the only source of truth for the
 * public IonAPI surface.
 */
import { ipcRenderer } from "electron";
import { IPC } from "../shared/types";
import { legacyReviewToStage } from "../shared/types-git";
import type { GitEvent } from "../shared/types";
import type { IonAPI } from "./ionapi";

export type GitIpcApi = Pick<
  IonAPI,
  | "gitIsRepo"
  | "gitGraph"
  | "gitChanges"
  | "gitCommit"
  | "gitFetch"
  | "gitPull"
  | "gitPush"
  | "gitBranches"
  | "gitCheckout"
  | "gitCreateBranch"
  | "gitDiff"
  | "gitStage"
  | "gitUnstage"
  | "gitDiscard"
  | "gitDeleteBranch"
  | "gitCommitDetail"
  | "gitCommitFiles"
  | "gitCommitFileDiff"
  | "gitIgnoredFiles"
  | "gitStashList"
  | "gitStashSave"
  | "gitStashPop"
  | "gitStashDrop"
  | "gitCherryPick"
  | "gitRevert"
  | "gitReset"
  | "gitBlame"
  | "gitResolveConflict"
  | "gitRebaseTodo"
  | "gitRebaseExec"
  | "gitRebaseAbort"
  | "gitRebaseContinue"
  | "gitOpState"
  | "gitConflictStages"
  | "gitConflictAccept"
  | "gitSubscribe"
  | "gitUnsubscribe"
  | "gitRefresh"
  | "gitApplyPatch"
  | "gitTagCreate"
  | "gitShowFile"
  | "gitCommitSignature"
  | "gitRecentRefs"
  | "onGitEvent"
  | "gitWorktreeAdd"
  | "gitWorktreeDiscard"
  | "gitWorktreeList"
  | "gitWorktreeStatus"
  | "gitWorktreeMerge"
  | "gitWorktreePush"
  | "gitWorktreeRebase"
  | "gitWorktreeLandAndRetire"
  | "gitWorktreeSync"
  | "gitWorktreeSyncAll"
  | "gitWorktreeBaseStatus"
  | "gitWorktreeInventory"
  | "gitWorktreeSeedTitle"
  | "gitWorktreeSetTitle"
  | "gitWorktreeSetStage"
  | "benchSetReview"
  | "benchList"
  | "benchResolvePath"
  | "benchEnsure"
  | "benchAddMember"
  | "benchRemoveMember"
  | "gitWorktreeRegistration"
  | "benchSetOrder"
  | "benchUpdateMember"
  | "benchUpdateAll"
  | "benchAssemble"
  | "benchResolveConflict"
  | "benchRerereCount"
  | "benchRerereForget"
  | "benchRerereDiscardAll"
  | "benchPrepareVerificationAnalysis"
  | "benchDiscardMemberRecordings"
  | "openWorktreeOverlap"
  | "getWorktreeOverlapContext"
  | "getWorktreeOverlap"
  | "previewWorktreeOverlap"
  | "previewWorktreeOverlapApply"
  | "applyWorktreeOverlap"
  | "solveWorktreeOverlap"
  | "autoOrderWorktreeOverlap"
  | "benchRefreshStaleness"
  | "benchReconcileResolution"
  | "gitWorktreeAppraise"
  | "gitWorktreeRetirePreview"
  | "gitWorktreeReprovision"
  | "gitWorktreeReattach"
  | "fsReadDir"
  | "fsReadFile"
  | "fsWriteFile"
  | "fsCreateDir"
  | "fsCreateFile"
  | "fsRename"
  | "fsDelete"
  | "fsSaveDialog"
  | "fsRevealInFinder"
  | "fsOpenNative"
  | "fsExists"
  | "fsWatchFile"
  | "fsUnwatchFile"
  | "onFileChanged"
>;

export const gitApi: GitIpcApi = {
  // ─── Git operations ───
  gitIsRepo: (directory) => ipcRenderer.invoke(IPC.GIT_IS_REPO, directory),
  gitGraph: (directory, skip, limit, search, author, extra) =>
    ipcRenderer.invoke(IPC.GIT_GRAPH, {
      directory,
      skip,
      limit,
      search,
      author,
      ...(extra ?? {}),
    }),
  gitChanges: (directory) => ipcRenderer.invoke(IPC.GIT_CHANGES, { directory }),
  gitCommit: (directory, message, opts) => {
    const args =
      typeof opts === "boolean"
        ? { directory, message, amend: opts }
        : {
            directory,
            message,
            amend: opts?.amend,
            signoff: opts?.signoff,
            gpg: opts?.gpg,
          };
    return ipcRenderer.invoke(IPC.GIT_COMMIT, args);
  },
  gitFetch: (directory) => ipcRenderer.invoke(IPC.GIT_FETCH, { directory }),
  gitPull: (directory) => ipcRenderer.invoke(IPC.GIT_PULL, { directory }),
  gitPush: (directory) => ipcRenderer.invoke(IPC.GIT_PUSH, { directory }),
  gitBranches: (directory) =>
    ipcRenderer.invoke(IPC.GIT_BRANCHES, { directory }),
  gitCheckout: (directory, branch) =>
    ipcRenderer.invoke(IPC.GIT_CHECKOUT, { directory, branch }),
  gitCreateBranch: (directory, name) =>
    ipcRenderer.invoke(IPC.GIT_CREATE_BRANCH, { directory, name }),
  gitDiff: (directory, path, staged) =>
    ipcRenderer.invoke(IPC.GIT_DIFF, { directory, path, staged }),
  gitStage: (directory, paths) =>
    ipcRenderer.invoke(IPC.GIT_STAGE, { directory, paths }),
  gitUnstage: (directory, paths) =>
    ipcRenderer.invoke(IPC.GIT_UNSTAGE, { directory, paths }),
  gitDiscard: (directory, paths) =>
    ipcRenderer.invoke(IPC.GIT_DISCARD, { directory, paths }),
  gitDeleteBranch: (directory, branch) =>
    ipcRenderer.invoke(IPC.GIT_DELETE_BRANCH, { directory, branch }),
  gitCommitDetail: (directory, hash) =>
    ipcRenderer.invoke(IPC.GIT_COMMIT_DETAIL, { directory, hash }),
  gitCommitFiles: (directory, hash) =>
    ipcRenderer.invoke(IPC.GIT_COMMIT_FILES, { directory, hash }),
  gitCommitFileDiff: (directory, hash, path) =>
    ipcRenderer.invoke(IPC.GIT_COMMIT_FILE_DIFF, { directory, hash, path }),
  gitIgnoredFiles: (directory) =>
    ipcRenderer.invoke(IPC.GIT_IGNORED_FILES, directory),
  gitStashList: (directory: string) =>
    ipcRenderer.invoke(IPC.GIT_STASH_LIST, { directory }),
  gitStashSave: (directory: string, message?: string) =>
    ipcRenderer.invoke(IPC.GIT_STASH_SAVE, { directory, message }),
  gitStashPop: (directory: string, ref?: string) =>
    ipcRenderer.invoke(IPC.GIT_STASH_POP, { directory, ref }),
  gitStashDrop: (directory: string, ref: string) =>
    ipcRenderer.invoke(IPC.GIT_STASH_DROP, { directory, ref }),
  gitCherryPick: (directory: string, hash: string) =>
    ipcRenderer.invoke(IPC.GIT_CHERRY_PICK, { directory, hash }),
  gitRevert: (directory: string, hash: string) =>
    ipcRenderer.invoke(IPC.GIT_REVERT, { directory, hash }),
  gitReset: (
    directory: string,
    hash: string,
    mode: "soft" | "mixed" | "hard",
  ) => ipcRenderer.invoke(IPC.GIT_RESET, { directory, hash, mode }),
  gitBlame: (directory: string, path: string) =>
    ipcRenderer.invoke(IPC.GIT_BLAME, { directory, path }),
  gitResolveConflict: (directory: string, path: string, content: string) =>
    ipcRenderer.invoke(IPC.GIT_RESOLVE_CONFLICT, { directory, path, content }),
  gitRebaseTodo: (directory: string, onto: string) =>
    ipcRenderer.invoke(IPC.GIT_REBASE_TODO, { directory, onto }),
  gitRebaseExec: (
    directory: string,
    onto: string,
    commits: Array<{ hash: string; action: string }>,
  ) => ipcRenderer.invoke(IPC.GIT_REBASE_EXEC, { directory, onto, commits }),
  gitRebaseAbort: (directory: string) =>
    ipcRenderer.invoke(IPC.GIT_REBASE_ABORT, { directory }),
  gitRebaseContinue: (directory: string) =>
    ipcRenderer.invoke(IPC.GIT_REBASE_CONTINUE, { directory }),
  gitOpState: (directory: string) =>
    ipcRenderer.invoke(IPC.GIT_OP_STATE, { directory }),
  gitConflictStages: (directory: string, path: string) =>
    ipcRenderer.invoke(IPC.GIT_CONFLICT_STAGES, { directory, path }),
  gitConflictAccept: (
    directory: string,
    path: string,
    side: "ours" | "theirs",
  ) => ipcRenderer.invoke(IPC.GIT_CONFLICT_ACCEPT, { directory, path, side }),
  gitSubscribe: (directory) =>
    ipcRenderer.invoke(IPC.GIT_SUBSCRIBE, { directory }),
  gitUnsubscribe: (directory) =>
    ipcRenderer.invoke(IPC.GIT_UNSUBSCRIBE, { directory }),
  gitRefresh: (directory) => ipcRenderer.invoke(IPC.GIT_REFRESH, { directory }),
  gitApplyPatch: (directory, patch, opts) =>
    ipcRenderer.invoke(IPC.GIT_APPLY_PATCH, {
      directory,
      patch,
      reverse: opts?.reverse,
      cached: opts?.cached,
    }),
  gitTagCreate: (directory, name, ref, message) =>
    ipcRenderer.invoke(IPC.GIT_TAG_CREATE, { directory, name, ref, message }),
  gitShowFile: (directory, hash, path) =>
    ipcRenderer.invoke(IPC.GIT_SHOW_FILE, { directory, hash, path }),
  gitCommitSignature: (directory, hash) =>
    ipcRenderer.invoke(IPC.GIT_COMMIT_SIGNATURE, { directory, hash }),
  gitRecentRefs: (directory, limit) =>
    ipcRenderer.invoke(IPC.GIT_RECENT_REFS, { directory, limit }),
  onGitEvent: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, event: GitEvent) =>
      callback(event);
    ipcRenderer.on(IPC.GIT_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC.GIT_EVENT, handler);
  },

  // ─── Git worktree operations ───
  gitWorktreeAdd: (repoPath, sourceBranch) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_ADD, { repoPath, sourceBranch }),
  gitWorktreeDiscard: (args) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_DISCARD, args),
  gitWorktreeList: (repoPath) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_LIST, { repoPath }),
  gitWorktreeStatus: (worktreePath, sourceBranch) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_STATUS, { worktreePath, sourceBranch }),
  gitWorktreeMerge: (repoPath, worktreeBranch, sourceBranch, noFf) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_MERGE, {
      repoPath,
      worktreeBranch,
      sourceBranch,
      noFf,
    }),
  gitWorktreePush: (worktreePath, sourceBranch) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_PUSH, { worktreePath, sourceBranch }),
  gitWorktreeRebase: (worktreePath, sourceBranch) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_REBASE, { worktreePath, sourceBranch }),
  gitWorktreeLandAndRetire: (args) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_LAND_AND_RETIRE, args),
  gitWorktreeSync: (worktreePath, sourceBranch) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_SYNC, { worktreePath, sourceBranch }),
  gitWorktreeSyncAll: (repoPath) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_SYNC_ALL, { repoPath }),
  gitWorktreeBaseStatus: (worktreePath, sourceBranch) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_BASE_STATUS, {
      worktreePath,
      sourceBranch,
    }),
  gitWorktreeInventory: (repoPath) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_INVENTORY, { repoPath }),
  gitWorktreeSeedTitle: (worktreePath, title) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_SEED_TITLE, { worktreePath, title }),
  gitWorktreeSetTitle: (args) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_SET_TITLE, args),
  gitWorktreeSetStage: (args) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_SET_STAGE, args),
  // Deprecated shim over gitWorktreeSetStage — see the ionapi.ts declaration
  // for the removal condition. The verdict→stage mapping is the shared
  // legacyReviewToStage table, the same one the workspaces-file load
  // migration uses, so the two cannot drift. `sourceBranch` is ignored:
  // stages are worktree-scoped.
  benchSetReview: (args) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_SET_STAGE, {
      worktreePath: args.worktreePath,
      repoPath: args.repoPath,
      stage: legacyReviewToStage(args.review) ?? null,
    }),
  benchList: (repoPath) => ipcRenderer.invoke(IPC.BENCH_LIST, { repoPath }),
  benchResolvePath: (directory) =>
    ipcRenderer.invoke(IPC.BENCH_RESOLVE_PATH, { directory }),
  benchEnsure: (repoPath, sourceBranch) =>
    ipcRenderer.invoke(IPC.BENCH_ENSURE, { repoPath, sourceBranch }),
  benchAddMember: (args) => ipcRenderer.invoke(IPC.BENCH_ADD_MEMBER, args),
  benchRemoveMember: (args) =>
    ipcRenderer.invoke(IPC.BENCH_REMOVE_MEMBER, args),
  gitWorktreeRegistration: (worktreePath) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_REGISTRATION, { worktreePath }),
  benchSetOrder: (args) => ipcRenderer.invoke(IPC.BENCH_SET_ORDER, args),
  benchUpdateMember: (args) =>
    ipcRenderer.invoke(IPC.BENCH_UPDATE_MEMBER, args),
  benchUpdateAll: (repoPath, sourceBranch) =>
    ipcRenderer.invoke(IPC.BENCH_UPDATE_ALL, { repoPath, sourceBranch }),
  benchAssemble: (repoPath, sourceBranch) =>
    ipcRenderer.invoke(IPC.BENCH_ASSEMBLE, { repoPath, sourceBranch }),
  benchResolveConflict: (repoPath, sourceBranch) =>
    ipcRenderer.invoke(IPC.BENCH_RESOLVE_CONFLICT, { repoPath, sourceBranch }),
  benchRerereCount: (directory) =>
    ipcRenderer.invoke(IPC.BENCH_RERERE_COUNT, { directory }),
  benchRerereForget: (directory, paths) =>
    ipcRenderer.invoke(IPC.BENCH_RERERE_FORGET, { directory, paths }),
  benchRerereDiscardAll: (directory) =>
    ipcRenderer.invoke(IPC.BENCH_RERERE_DISCARD_ALL, { directory }),
  benchPrepareVerificationAnalysis: (repoPath, sourceBranch) =>
    ipcRenderer.invoke(IPC.BENCH_PREPARE_VERIFICATION_ANALYSIS, {
      repoPath,
      sourceBranch,
    }),
  benchDiscardMemberRecordings: (repoPath, sourceBranch, branchNames) =>
    ipcRenderer.invoke(IPC.BENCH_DISCARD_MEMBER_RECORDINGS, {
      repoPath,
      sourceBranch,
      branchNames,
    }),
  openWorktreeOverlap: (context) =>
    ipcRenderer.send(IPC.WORKTREE_OVERLAP_OPEN, context),
  getWorktreeOverlapContext: () =>
    ipcRenderer.invoke(IPC.WORKTREE_OVERLAP_CONTEXT),
  getWorktreeOverlap: (basis) =>
    ipcRenderer.invoke(IPC.WORKTREE_OVERLAP_ANALYZE, basis),
  previewWorktreeOverlap: (basis, paths) =>
    ipcRenderer.invoke(IPC.WORKTREE_OVERLAP_PREVIEW, basis, paths),
  previewWorktreeOverlapApply: (basis, paths) =>
    ipcRenderer.invoke(IPC.WORKTREE_OVERLAP_APPLY_PREVIEW, basis, paths),
  applyWorktreeOverlap: (basis, paths) =>
    ipcRenderer.invoke(IPC.WORKTREE_OVERLAP_APPLY, basis, paths),
  solveWorktreeOverlap: (basis, keptPaths) =>
    ipcRenderer.invoke(IPC.WORKTREE_OVERLAP_SOLVE, basis, keptPaths),
  autoOrderWorktreeOverlap: (basis, paths) =>
    ipcRenderer.invoke(IPC.WORKTREE_OVERLAP_AUTO_ORDER, basis, paths),
  benchRefreshStaleness: (repoPath, sourceBranch) =>
    ipcRenderer.invoke(IPC.BENCH_REFRESH_STALENESS, { repoPath, sourceBranch }),
  benchReconcileResolution: (directory) =>
    ipcRenderer.invoke(IPC.BENCH_RECONCILE_RESOLUTION, { directory }),
  gitWorktreeAppraise: (worktreePath, sourceBranch) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_APPRAISE, {
      worktreePath,
      sourceBranch,
    }),
  gitWorktreeRetirePreview: (worktreePath) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_RETIRE_PREVIEW, { worktreePath }),
  gitWorktreeReprovision: (args) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_REPROVISION, args),
  gitWorktreeReattach: (args) =>
    ipcRenderer.invoke(IPC.GIT_WORKTREE_REATTACH, args),

  // ─── Filesystem operations ───
  fsReadDir: (directory) => ipcRenderer.invoke(IPC.FS_READ_DIR, { directory }),
  fsReadFile: (filePath) => ipcRenderer.invoke(IPC.FS_READ_FILE, { filePath }),
  fsWriteFile: (filePath, content) =>
    ipcRenderer.invoke(IPC.FS_WRITE_FILE, { filePath, content }),
  fsCreateDir: (dirPath) => ipcRenderer.invoke(IPC.FS_CREATE_DIR, { dirPath }),
  fsCreateFile: (filePath) =>
    ipcRenderer.invoke(IPC.FS_CREATE_FILE, { filePath }),
  fsRename: (oldPath, newPath) =>
    ipcRenderer.invoke(IPC.FS_RENAME, { oldPath, newPath }),
  fsDelete: (targetPath) => ipcRenderer.invoke(IPC.FS_DELETE, { targetPath }),
  fsSaveDialog: (defaultPath, defaultFileName) =>
    ipcRenderer.invoke(IPC.FS_SAVE_DIALOG, { defaultPath, defaultFileName }),
  fsRevealInFinder: (targetPath) =>
    ipcRenderer.invoke(IPC.FS_REVEAL_IN_FINDER, { targetPath }),
  fsOpenNative: (targetPath) =>
    ipcRenderer.invoke(IPC.FS_OPEN_NATIVE, { targetPath }),
  fsExists: (targetPath) => ipcRenderer.invoke(IPC.FS_EXISTS, { targetPath }),
  fsWatchFile: (filePath) =>
    ipcRenderer.invoke(IPC.FS_WATCH_FILE, { filePath }),
  fsUnwatchFile: (filePath) =>
    ipcRenderer.invoke(IPC.FS_UNWATCH_FILE, { filePath }),
  onFileChanged: (callback) => {
    const handler = (_e: Electron.IpcRendererEvent, filePath: string) =>
      callback(filePath);
    ipcRenderer.on(IPC.FS_FILE_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC.FS_FILE_CHANGED, handler);
  },
};
