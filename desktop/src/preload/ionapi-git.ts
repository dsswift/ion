/**
 * The IonAPI contextBridge surface type, extracted from preload/index.ts to
 * keep that file under the 600-line cap. index.ts implements this interface and
 * re-exports it (renderer/env.d.ts imports it from ../preload/index).
 */
import type {
  GitGraphData,
  GitChangesData,
  GitBranchInfo,
  GitCommitDetail,
  GitDiffResult,
  GitEvent,
  RepoSnapshot,
} from "../shared/types";
import type {} from "../shared/types-ipc";
import type {} from "../shared/types-automation";

export interface IonGitApi {
  // ─── Git operations ───
  gitIsRepo(directory: string): Promise<{ isRepo: boolean }>;
  gitGraph(
    directory: string,
    skip?: number,
    limit?: number,
    search?: string,
    author?: string,
    extra?: {
      path?: string;
      refKind?: string;
      dateAfter?: string;
      dateBefore?: string;
    },
  ): Promise<GitGraphData>;
  gitChanges(directory: string): Promise<GitChangesData>;
  gitCommit(
    directory: string,
    message: string,
    opts?: { amend?: boolean; signoff?: boolean; gpg?: boolean } | boolean,
  ): Promise<{ ok: boolean; error?: string }>;
  gitFetch(directory: string): Promise<{ ok: boolean; error?: string }>;
  gitPull(directory: string): Promise<{ ok: boolean; error?: string }>;
  gitPush(directory: string): Promise<{ ok: boolean; error?: string }>;
  gitBranches(
    directory: string,
  ): Promise<{ branches: GitBranchInfo[]; current: string }>;
  gitCheckout(
    directory: string,
    branch: string,
  ): Promise<{ ok: boolean; error?: string }>;
  gitCreateBranch(
    directory: string,
    name: string,
  ): Promise<{ ok: boolean; error?: string }>;
  gitDiff(
    directory: string,
    path: string,
    staged: boolean,
  ): Promise<GitDiffResult>;
  gitStage(
    directory: string,
    paths: string[],
  ): Promise<{ ok: boolean; error?: string }>;
  gitUnstage(
    directory: string,
    paths: string[],
  ): Promise<{ ok: boolean; error?: string }>;
  gitDiscard(
    directory: string,
    paths: string[],
  ): Promise<{ ok: boolean; error?: string }>;
  gitDeleteBranch(
    directory: string,
    branch: string,
  ): Promise<{ ok: boolean; error?: string }>;
  gitCommitDetail(directory: string, hash: string): Promise<GitCommitDetail>;
  gitCommitFiles(
    directory: string,
    hash: string,
  ): Promise<{
    files: Array<{ path: string; status: string; oldPath?: string }>;
  }>;
  gitCommitFileDiff(
    directory: string,
    hash: string,
    path: string,
  ): Promise<GitDiffResult>;
  gitIgnoredFiles(directory: string): Promise<{ paths: string[] }>;
  gitStashList(directory: string): Promise<{
    stashes: Array<{
      ref: string;
      message: string;
      date: string;
      parentSha?: string;
    }>;
  }>;
  gitStashSave(
    directory: string,
    message?: string,
  ): Promise<{ ok: boolean; error?: string }>;
  gitStashPop(
    directory: string,
    ref?: string,
  ): Promise<{ ok: boolean; error?: string }>;
  gitStashDrop(
    directory: string,
    ref: string,
  ): Promise<{ ok: boolean; error?: string }>;
  gitCherryPick(
    directory: string,
    hash: string,
  ): Promise<{ ok: boolean; error?: string }>;
  gitRevert(
    directory: string,
    hash: string,
  ): Promise<{ ok: boolean; error?: string }>;
  gitReset(
    directory: string,
    hash: string,
    mode: "soft" | "mixed" | "hard",
  ): Promise<{ ok: boolean; error?: string }>;
  gitBlame(
    directory: string,
    path: string,
  ): Promise<{
    lines: Array<{
      hash: string;
      author: string;
      date: string;
      lineNo: number;
      content: string;
    }>;
    ok: boolean;
    error?: string;
  }>;
  gitResolveConflict(
    directory: string,
    path: string,
    content: string,
  ): Promise<{ ok: boolean; error?: string }>;
  gitRebaseTodo(
    directory: string,
    onto: string,
  ): Promise<{
    commits: Array<{ hash: string; subject: string; action: string }>;
    ok: boolean;
    error?: string;
  }>;
  gitRebaseExec(
    directory: string,
    onto: string,
    commits: Array<{ hash: string; action: string }>,
  ): Promise<{ ok: boolean; error?: string }>;
  gitRebaseAbort(directory: string): Promise<{ ok: boolean; error?: string }>;
  gitRebaseContinue(
    directory: string,
  ): Promise<{ ok: boolean; error?: string }>;
  gitOpState(directory: string): Promise<{
    ok: boolean;
    error?: string;
    state?: "rebasing" | "merging" | "cherry-picking" | null;
    branch?: string | null;
    onto?: string | null;
    oursLabel?: string;
    theirsLabel?: string;
    files?: Array<{
      path: string;
      shape: string;
      hasBase: boolean;
      hasOurs: boolean;
      hasTheirs: boolean;
    }>;
  }>;
  gitConflictStages(
    directory: string,
    path: string,
  ): Promise<{
    ok: boolean;
    error?: string;
    base?: string | null;
    ours?: string | null;
    theirs?: string | null;
    oursLabel?: string;
    theirsLabel?: string;
  }>;
  gitConflictAccept(
    directory: string,
    path: string,
    side: "ours" | "theirs",
  ): Promise<{ ok: boolean; error?: string }>;
  gitSubscribe(directory: string): Promise<{ snapshot: RepoSnapshot | null }>;
  gitUnsubscribe(directory: string): Promise<{ ok: boolean }>;
  gitRefresh(directory: string): Promise<{ ok: boolean }>;
  gitApplyPatch(
    directory: string,
    patch: string,
    opts?: { reverse?: boolean; cached?: boolean },
  ): Promise<{ ok: boolean; error?: string }>;
  gitTagCreate(
    directory: string,
    name: string,
    ref?: string,
    message?: string,
  ): Promise<{ ok: boolean; error?: string }>;
  gitShowFile(
    directory: string,
    hash: string,
    path: string,
  ): Promise<{ ok: boolean; content: string; error?: string }>;
  gitCommitSignature(
    directory: string,
    hash: string,
  ): Promise<{
    ok: boolean;
    status?: string;
    signer?: string;
    key?: string;
    error?: string;
  }>;
  gitRecentRefs(
    directory: string,
    limit?: number,
  ): Promise<{ ok: boolean; refs: string[]; error?: string }>;
  onGitEvent(callback: (event: GitEvent) => void): () => void;
}
