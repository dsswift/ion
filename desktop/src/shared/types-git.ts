// ─── Git Types ───
//
// Extracted from types-session.ts to keep that file under the 600-line cap.
// Re-exported from types-session.ts so existing import paths keep working.

export interface GitCommit {
  hash: string
  fullHash: string
  parents: string[]
  authorName: string
  authorDate: string
  subject: string
  refs: GitRef[]
}

export interface GitRef {
  name: string
  type: 'head' | 'remote' | 'tag'
  isCurrent: boolean
}

export interface GitCommitDetail {
  filesChanged: number
  insertions: number
  deletions: number
}

export interface GitCommitFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed'
  oldPath?: string
}

export interface GitGraphData {
  commits: GitCommit[]
  isGitRepo: boolean
  totalCount: number
}

export type GitConflictKind = 'UU' | 'AA' | 'DD' | 'AU' | 'UA' | 'DU' | 'UD'

export interface GitChangedFile {
  path: string
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict'
  staged: boolean
  oldPath?: string
  conflictKind?: GitConflictKind
  isSubmodule?: boolean
}

export interface GitChangesData {
  files: GitChangedFile[]
  branch: string
  isGitRepo: boolean
  ahead: number
  behind: number
}

export interface GitBranchInfo {
  name: string
  isCurrent: boolean
  upstream: string | null
  isRemote: boolean
}
