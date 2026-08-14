/**
 * Worktree overlap contracts. These are desktop-local analysis results, never a
 * wire contract: a dense graph is not a useful mobile snapshot.
 */

export type WorktreeOverlapBasis = 'live' | 'pins'
export type WorktreeChangeLayer = 'committed' | 'staged' | 'unstaged' | 'untracked'
export type WorktreeChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'binary'
export type MergePrediction = 'clean' | 'conflict' | 'unavailable'

export interface WorktreeLineRange {
  start: number
  end: number
}

export interface WorktreeChangedFile {
  path: string
  oldPath?: string
  kind: WorktreeChangeKind
  additions: number | null
  deletions: number | null
  hunks: WorktreeLineRange[]
  layers: WorktreeChangeLayer[]
}

export interface WorktreeFootprint {
  worktreePath: string
  branchName: string
  title?: string
  sourceBranch: string | null
  baseSha?: string
  tipSha?: string
  treeHash?: string
  files: WorktreeChangedFile[]
  incompleteReason?: string
  enrolled: boolean
  enabled?: boolean
  order?: number
  landed: boolean
}

export interface WorktreeOverlapPair {
  leftPath: string
  rightPath: string
  sharedDirectories: string[]
  sharedFiles: Array<{
    path: string
    left: WorktreeChangedFile
    right: WorktreeChangedFile
    sameHunk: boolean
  }>
  advisoryFiles: string[]
  ancestry: 'left-contains-right' | 'right-contains-left' | 'diverged' | 'unavailable'
  prediction: MergePrediction
  conflictPaths: string[]
  error?: string
}

export interface WorktreeOverlapRecommendation {
  /** Exact = exhaustive within the candidate cap; anchored = a bounded fallback. */
  kind: 'exact' | 'anchored'
  orderedPaths: string[]
  alternatives: string[][]
  blockers: Array<{
    worktreePath: string
    branchName: string
    blockedByPath?: string
    blockedByBranch?: string
    conflictPaths: string[]
    reason: 'conflict' | 'incomplete' | 'landed' | 'empty'
    detail: string
  }>
  /** Pair cards relevant to the recommendation or a concrete exclusion. */
  pairScope: Array<{ leftPath: string; rightPath: string }>
}

export interface WorktreeOverlapCohort extends WorktreeOverlapRecommendation {
  prediction: MergePrediction
  firstFailingPath?: string
  firstFailingBranch?: string
  conflictPaths: string[]
  note?: string
}

export interface WorktreeOverlapSolverResult {
  /** Best cohort that must retain every Keep-pinned worktree. */
  constrained: WorktreeOverlapCohort
  /** Best cohort with no operator membership constraint. */
  hypothetical: WorktreeOverlapCohort
  /** Current selected membership after the automatic low-friction ordering. */
  current: WorktreeOverlapCohort
  keptPaths: string[]
}
export interface WorktreeOverlapAnalysis {
  repoPath: string
  sourceBranch: string
  basis: WorktreeOverlapBasis
  computedAt: number
  footprints: WorktreeFootprint[]
  pairs: WorktreeOverlapPair[]
  recommendation: WorktreeOverlapRecommendation
  incompletePaths: string[]
}

export interface WorktreeOverlapApplyPreview {
  orderedPaths: string[]
  newlyEnrolled: string[]
  enabled: string[]
  disabled: string[]
  orderChanged: string[]
  prediction: MergePrediction
  error?: string
}

export interface WorktreeOverlapApplyResult {
  ok: boolean
  error?: string
  applied?: { newlyEnrolled: number; enabled: number; disabled: number; reordered: number }
}
export interface WorktreeOverlapContext {
  repoPath: string
  sourceBranch?: string
}

export interface WorktreeOverlapPreview {
  sourceBranch: string
  basis: WorktreeOverlapBasis
  orderedPaths: string[]
  prediction: MergePrediction
  firstFailingPath?: string
  firstFailingBranch?: string
  conflictPaths: string[]
  error?: string
}
