import type { WorktreeOverlapAnalysis } from '../../shared/types-worktree-overlap'

/** Limit visualization evidence to worktrees with changed paths matching filter. */
export function filterOverlapAnalysis(analysis: WorktreeOverlapAnalysis | null, filter: string): WorktreeOverlapAnalysis | null {
  if (!analysis || !filter.trim()) return analysis
  const term = filter.toLowerCase()
  const footprints = analysis.footprints.filter((item) => item.files.some((file) => file.path.toLowerCase().includes(term)))
  const paths = new Set(footprints.map((item) => item.worktreePath))
  return {
    ...analysis,
    footprints,
    pairs: analysis.pairs.filter((pair) => paths.has(pair.leftPath) && paths.has(pair.rightPath)),
    incompletePaths: analysis.incompletePaths.filter((path) => paths.has(path)),
  }
}
