/** Exact constrained solver for worktree overlap choices. */
import { mergeTree } from '../integration/merge-tree'
import { runGit } from '../git-runner'
import type {
  WorktreeFootprint,
  WorktreeOverlapAnalysis,
  WorktreeOverlapCohort,
  WorktreeOverlapRecommendation,
  WorktreeOverlapSolverResult,
} from '../../shared/types-worktree-overlap'

const EXACT_CANDIDATE_CAP = 12

interface SearchResult { paths: string[]; tree: string; penalty: number }

type Analysis = Pick<WorktreeOverlapAnalysis, 'repoPath' | 'sourceBranch' | 'footprints' | 'pairs'>

export async function recommendWorktreeCohort(analysis: Analysis): Promise<WorktreeOverlapRecommendation> {
  return (await solveWorktreeOverlap(analysis, [])).hypothetical
}

export async function solveWorktreeOverlap(analysis: Analysis, keptPaths: string[]): Promise<WorktreeOverlapSolverResult> {
  const eligible = stableOrder(analysis.footprints.filter((item) => !exclusionReason(item)))
  const kept = eligible.filter((item) => keptPaths.includes(item.worktreePath))
  const base = (await runGit(analysis.repoPath, ['rev-parse', analysis.sourceBranch])).trim()
  const kind = eligible.length > EXACT_CANDIDATE_CAP ? 'anchored' : 'exact'
  const pool = kind === 'exact' ? eligible : anchoredCandidates(eligible, kept)
  const hypothetical = await bestCohort(analysis, base, pool, [], kind)
  const constrainedSeed = await mergeSequence(analysis, base, kept)
  const constrained = constrainedSeed.prediction === 'clean'
    ? await bestCohort(analysis, constrainedSeed.tree!, pool.filter((item) => !kept.includes(item)), kept.map((item) => item.worktreePath), kind)
    : cohortFromFailed(analysis, kept.map((item) => item.worktreePath), constrainedSeed, kind, 'Kept worktrees do not merge cleanly together.')
  const currentPaths = stableOrder(eligible.filter((item) => item.enrolled && item.enabled)).map((item) => item.worktreePath)
  const current = await reorderCurrentSelection(analysis, base, currentPaths, currentPaths.length > EXACT_CANDIDATE_CAP ? 'anchored' : kind)
  return { constrained, hypothetical, current, keptPaths }
}

async function bestCohort(analysis: Analysis, base: string, pool: WorktreeFootprint[], seedPaths: string[], kind: 'exact' | 'anchored'): Promise<WorktreeOverlapCohort> {
  const seed: SearchResult = { paths: seedPaths, tree: base, penalty: 0 }
  const result = await search(analysis, pool, seed)
  return cohortFromResult(analysis, result, pool, kind)
}

/** Reorder existing selection only. Never drops a selected worktree. */
export async function reorderCurrentSelection(analysis: Analysis, base: string, paths: string[], kind: 'exact' | 'anchored'): Promise<WorktreeOverlapCohort> {
  const items = paths.map((path) => analysis.footprints.find((item) => item.worktreePath === path)).filter((item): item is WorktreeFootprint => !!item)
  if (items.length > EXACT_CANDIDATE_CAP) {
    const sequence = await mergeSequence(analysis, base, items)
    const note = `Selection has ${items.length} worktrees. Auto-order examines at most ${EXACT_CANDIDATE_CAP}; existing order is retained.`
    return sequence.prediction === 'clean'
      ? { ...cohortFromResult(analysis, { paths: sequence.paths, tree: sequence.tree!, penalty: sequence.penalty }, items, 'anchored'), note }
      : cohortFromFailed(analysis, paths, sequence, 'anchored', note)
  }
  const result = await findBestOrder(analysis, base, items)
  return result.prediction === 'clean'
    ? cohortFromResult(analysis, { paths: result.paths, tree: result.tree!, penalty: result.penalty }, items, kind)
    : cohortFromFailed(analysis, paths, result, kind, 'Current selection cannot merge cleanly in any tested order.')
}

async function findBestOrder(analysis: Analysis, base: string, items: WorktreeFootprint[]): Promise<SearchResult & { prediction: 'clean' | 'conflict'; conflictPaths: string[]; firstFailingPath?: string; firstFailingBranch?: string }> {
  let best: SearchResult = { paths: [], tree: base, penalty: Number.POSITIVE_INFINITY }
  let found = false
  let firstFailure: { conflictPaths: string[]; firstFailingPath?: string; firstFailingBranch?: string } = { conflictPaths: [] }
  const visit = async (remaining: WorktreeFootprint[], current: SearchResult): Promise<void> => {
    if (remaining.length === 0) {
      if (!found || current.penalty < best.penalty) { best = current; found = true }
      return
    }
    for (const item of remaining) {
      if (!item.tipSha) continue
      const merged = await mergeTree(analysis.repoPath, current.tree, item.tipSha)
      if (merged.prediction !== 'clean' || !merged.tree) {
        if (firstFailure.conflictPaths.length === 0) firstFailure = { conflictPaths: merged.conflictPaths, firstFailingPath: item.worktreePath, firstFailingBranch: item.branchName }
        continue
      }
      const tree = await commitSynthetic(analysis.repoPath, merged.tree, current.tree, item.tipSha)
      await visit(remaining.filter((other) => other !== item), { paths: [...current.paths, item.worktreePath], tree, penalty: current.penalty + overlapPenalty(analysis, current.paths, item.worktreePath) })
    }
  }
  await visit(items, { paths: [], tree: base, penalty: 0 })
  if (found) return { paths: best.paths, tree: best.tree, penalty: best.penalty, prediction: 'clean', conflictPaths: [] }
  return { paths: items.map((item) => item.worktreePath), tree: base, penalty: 0, prediction: 'conflict', ...firstFailure }
}

async function mergeSequence(analysis: Analysis, base: string, items: WorktreeFootprint[]): Promise<{ prediction: 'clean' | 'conflict'; tree?: string; paths: string[]; penalty: number; conflictPaths: string[]; firstFailingPath?: string; firstFailingBranch?: string }> {
  let tree = base
  const paths: string[] = []
  let penalty = 0
  for (const item of items) {
    if (!item.tipSha) continue
    const merged = await mergeTree(analysis.repoPath, tree, item.tipSha)
    if (merged.prediction !== 'clean' || !merged.tree) return { prediction: 'conflict', paths, penalty, conflictPaths: merged.conflictPaths, firstFailingPath: item.worktreePath, firstFailingBranch: item.branchName }
    tree = await commitSynthetic(analysis.repoPath, merged.tree, tree, item.tipSha)
    penalty += overlapPenalty(analysis, paths, item.worktreePath)
    paths.push(item.worktreePath)
  }
  return { prediction: 'clean', tree, paths, penalty, conflictPaths: [] }
}

async function search(analysis: Analysis, candidates: WorktreeFootprint[], seed: SearchResult): Promise<SearchResult> {
  let best = seed
  const visit = async (index: number, current: SearchResult): Promise<void> => {
    if (current.paths.length + candidates.length - index < best.paths.length) return
    if (index >= candidates.length) { if (better(current, best)) best = current; return }
    const candidate = candidates[index]
    await visit(index + 1, current)
    if (!candidate.tipSha || hasKnownConflict(analysis, current.paths, candidate.worktreePath)) return
    const merged = await mergeTree(analysis.repoPath, current.tree, candidate.tipSha)
    if (merged.prediction !== 'clean' || !merged.tree) return
    const tree = await commitSynthetic(analysis.repoPath, merged.tree, current.tree, candidate.tipSha)
    await visit(index + 1, { paths: [...current.paths, candidate.worktreePath], tree, penalty: current.penalty + overlapPenalty(analysis, current.paths, candidate.worktreePath) })
  }
  await visit(0, seed)
  return best
}

function cohortFromResult(analysis: Analysis, result: SearchResult, pool: WorktreeFootprint[], kind: 'exact' | 'anchored'): WorktreeOverlapCohort {
  const blockers = staticAndDynamicBlockers(analysis, pool, result.paths)
  return { kind, orderedPaths: result.paths, alternatives: [], blockers, pairScope: scopePairs(analysis, result.paths, blockers.map((blocker) => blocker.worktreePath)), prediction: 'clean', conflictPaths: [] }
}

function cohortFromFailed(analysis: Analysis, paths: string[], failure: { conflictPaths: string[]; firstFailingPath?: string; firstFailingBranch?: string }, kind: 'exact' | 'anchored', note: string): WorktreeOverlapCohort {
  return { kind, orderedPaths: paths, alternatives: [], blockers: [], pairScope: scopePairs(analysis, paths, []), prediction: 'conflict', conflictPaths: failure.conflictPaths, firstFailingPath: failure.firstFailingPath, firstFailingBranch: failure.firstFailingBranch, note }
}

function exclusionReason(item: WorktreeFootprint): 'incomplete' | 'landed' | 'empty' | undefined {
  if (item.incompleteReason || !item.tipSha || !item.baseSha) return 'incomplete'
  if (item.landed) return 'landed'
  if (item.baseSha === item.tipSha) return 'empty'
  return undefined
}
function stableOrder(items: WorktreeFootprint[]): WorktreeFootprint[] { return [...items].sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) || left.worktreePath.localeCompare(right.worktreePath)) }
function anchoredCandidates(items: WorktreeFootprint[], kept: WorktreeFootprint[]): WorktreeFootprint[] {
  // Keep constraints always survive. Only optional candidates consume bounded-search capacity.
  return [...kept, ...items.filter((item) => !kept.includes(item)).slice(0, Math.max(0, EXACT_CANDIDATE_CAP - kept.length))]
}
function better(left: SearchResult, right: SearchResult): boolean { return left.paths.length > right.paths.length || (left.paths.length === right.paths.length && left.penalty < right.penalty) }
function hasKnownConflict(analysis: Analysis, paths: string[], candidate: string): boolean { return analysis.pairs.some((pair) => pair.prediction === 'conflict' && ((pair.leftPath === candidate && paths.includes(pair.rightPath)) || (pair.rightPath === candidate && paths.includes(pair.leftPath)))) }
function overlapPenalty(analysis: Analysis, paths: string[], candidate: string): number { return analysis.pairs.filter((pair) => (pair.leftPath === candidate && paths.includes(pair.rightPath)) || (pair.rightPath === candidate && paths.includes(pair.leftPath))).reduce((total, pair) => total + pair.sharedFiles.length + pair.sharedFiles.filter((file) => file.sameHunk).length, 0) }
async function commitSynthetic(repoPath: string, tree: string, parent: string, tip: string): Promise<string> { return (await runGit(repoPath, ['commit-tree', tree, '-p', parent, '-p', tip, '-m', 'ion-worktree-overlap: recommendation'])).trim() }

function staticAndDynamicBlockers(analysis: Analysis, pool: WorktreeFootprint[], selected: string[]): WorktreeOverlapRecommendation['blockers'] {
  return pool.filter((item) => !selected.includes(item.worktreePath)).map((item) => {
    const reason = exclusionReason(item)
    if (reason) return staticBlocker(item)
    return dynamicBlocker(analysis, selected, item)
  })
}
function staticBlocker(item: WorktreeFootprint): WorktreeOverlapRecommendation['blockers'][number] { const reason = exclusionReason(item) ?? 'incomplete'; const detail = reason === 'landed' ? 'Already landed into source.' : reason === 'empty' ? 'No committed contribution yet.' : item.incompleteReason ?? 'No recorded contribution base.'; return { worktreePath: item.worktreePath, branchName: item.branchName, conflictPaths: [], reason, detail } }
function dynamicBlocker(analysis: Analysis, selected: string[], candidate: WorktreeFootprint): WorktreeOverlapRecommendation['blockers'][number] { const direct = analysis.pairs.find((pair) => pair.prediction === 'conflict' && ((pair.leftPath === candidate.worktreePath && selected.includes(pair.rightPath)) || (pair.rightPath === candidate.worktreePath && selected.includes(pair.leftPath)))); const counterpart = direct ? (direct.leftPath === candidate.worktreePath ? direct.rightPath : direct.leftPath) : undefined; const counterpartBranch = analysis.footprints.find((item) => item.worktreePath === counterpart)?.branchName; return { worktreePath: candidate.worktreePath, branchName: candidate.branchName, blockedByPath: counterpart, blockedByBranch: counterpartBranch, conflictPaths: direct?.conflictPaths ?? [], reason: 'conflict', detail: counterpartBranch ? `Conflicts with ${counterpartBranch} in the selected cohort.` : 'Does not merge cleanly with the selected cohort.' } }
function scopePairs(analysis: Analysis, selected: string[], blockers: string[]): WorktreeOverlapRecommendation['pairScope'] { return analysis.pairs.filter((pair) => (selected.includes(pair.leftPath) && selected.includes(pair.rightPath)) || (pair.prediction === 'conflict' && (blockers.includes(pair.leftPath) || blockers.includes(pair.rightPath)))).map(({ leftPath, rightPath }) => ({ leftPath, rightPath })) }
