/** Pure overlap joins. */
import type { WorktreeChangedFile, WorktreeFootprint, WorktreeOverlapPair } from '../../shared/types-worktree-overlap'

export function overlapPair(left: WorktreeFootprint, right: WorktreeFootprint): WorktreeOverlapPair {
  const rightFiles = new Map(right.files.map((file) => [file.path, file]))
  const sharedFiles = left.files.flatMap((leftFile) => {
    const rightFile = rightFiles.get(leftFile.path)
    return rightFile ? [{ path: leftFile.path, left: leftFile, right: rightFile, sameHunk: intersectsHunk(leftFile, rightFile) }] : []
  })
  const advisoryFiles = sharedFiles
    .filter(({ left: a, right: b }) => !a.layers.includes('committed') || !b.layers.includes('committed'))
    .map(({ path }) => path)
  return {
    leftPath: left.worktreePath,
    rightPath: right.worktreePath,
    sharedDirectories: sharedDirectories(left.files, right.files),
    sharedFiles,
    advisoryFiles,
    ancestry: 'unavailable',
    prediction: 'unavailable',
    conflictPaths: [],
  }
}

export function intersectsHunk(left: WorktreeChangedFile, right: WorktreeChangedFile): boolean {
  if (!left.layers.includes('committed') || !right.layers.includes('committed')) return false
  return left.hunks.some((a) => right.hunks.some((b) => a.start <= b.end && b.start <= a.end))
}

function sharedDirectories(left: WorktreeChangedFile[], right: WorktreeChangedFile[]): string[] {
  const directories = new Set(right.map((file) => parent(file.path)))
  return [...new Set(left.map((file) => parent(file.path)).filter((directory) => directories.has(directory)))].sort()
}

function parent(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '.' : path.slice(0, slash)
}
