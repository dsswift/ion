/** Exact selected-set merge preview. Never writes a checkout or bench record. */
import { runGit } from '../git-runner'
import { mergeTree } from '../integration/merge-tree'
import type { WorktreeOverlapAnalysis, WorktreeOverlapPreview } from '../../shared/types-worktree-overlap'

export async function previewWorktreeOverlap(
  analysis: WorktreeOverlapAnalysis,
  orderedPaths: string[],
): Promise<WorktreeOverlapPreview> {
  if (new Set(orderedPaths).size !== orderedPaths.length) {
    return unavailable(analysis, orderedPaths, 'Each selected worktree may appear only once.')
  }
  let simulated = (await runGit(analysis.repoPath, ['rev-parse', analysis.sourceBranch])).trim()
  for (const path of orderedPaths) {
    const footprint = analysis.footprints.find((item) => item.worktreePath === path)
    if (!footprint?.tipSha) {
      return unavailable(analysis, orderedPaths, `No committed contribution is available for ${path}.`)
    }
    const merged = await mergeTree(analysis.repoPath, simulated, footprint.tipSha)
    if (merged.prediction !== 'clean' || !merged.tree) {
      return {
        sourceBranch: analysis.sourceBranch,
        basis: analysis.basis,
        orderedPaths,
        prediction: merged.prediction,
        firstFailingPath: path,
        firstFailingBranch: footprint.branchName,
        conflictPaths: merged.conflictPaths,
        error: merged.error,
      }
    }
    simulated = (await runGit(analysis.repoPath, [
      'commit-tree', merged.tree, '-p', simulated, '-p', footprint.tipSha, '-m', 'ion-worktree-overlap: preview',
    ])).trim()
  }
  return { sourceBranch: analysis.sourceBranch, basis: analysis.basis, orderedPaths, prediction: 'clean', conflictPaths: [] }
}

function unavailable(
  analysis: WorktreeOverlapAnalysis,
  orderedPaths: string[],
  error: string,
): WorktreeOverlapPreview {
  return { sourceBranch: analysis.sourceBranch, basis: analysis.basis, orderedPaths, prediction: 'unavailable', conflictPaths: [], error }
}
