/**
 * Git event union pushed from main → renderer over GIT_EVENT.
 *
 * Snapshots flow over GIT_SNAPSHOT for initial hydration and drift recovery.
 * Every event carries a `revision` number; the renderer detects gaps and
 * re-requests a snapshot.
 */

import type { GitChangedFile } from './types-session'

export interface ResourceGroups {
  index: GitChangedFile[]
  workingTree: GitChangedFile[]
  untracked: GitChangedFile[]
  merge: GitChangedFile[]
}

export interface HeadInfo {
  branch: string | null
  detached: boolean
  sha: string | null
}

export interface UpstreamInfo {
  name: string | null
  ahead: number
  behind: number
}

export type MergeState = 'none' | 'merging' | 'rebasing' | 'cherry-picking'

export interface RefDelta {
  name: string
  type: 'head' | 'remote' | 'tag'
  sha: string
}

export interface RepoSnapshot {
  repoPath: string
  isGitRepo: boolean
  head: HeadInfo
  upstream: UpstreamInfo
  mergeState: MergeState
  groups: ResourceGroups
  revision: number
  /** True when the git file watcher was not started because the path is in gitWatcherIgnoredDirectories. */
  watcherIgnored: boolean
}

export type GitEvent =
  | {
      kind: 'status:changed'
      repoPath: string
      revision: number
      added: GitChangedFile[]
      removed: string[]
      modified: GitChangedFile[]
    }
  | {
      kind: 'head:changed'
      repoPath: string
      revision: number
      head: HeadInfo
    }
  | {
      kind: 'refs:changed'
      repoPath: string
      revision: number
      added: RefDelta[]
      removed: string[]
      updated: RefDelta[]
    }
  | {
      kind: 'upstream:changed'
      repoPath: string
      revision: number
      ahead: number
      behind: number
    }
  | {
      kind: 'merge:changed'
      repoPath: string
      revision: number
      state: MergeState
    }
  | {
      kind: 'op:started'
      repoPath: string
      opId: string
      opKind: string
    }
  | {
      kind: 'op:completed'
      repoPath: string
      opId: string
      ok: boolean
      error?: string
      durationMs: number
    }
  | {
      kind: 'op:cancelled'
      repoPath: string
      opId: string
    }
