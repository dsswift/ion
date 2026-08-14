/** Atomic application of a validated overlap selection. */
import { repositoryManager } from '../git/repositoryManager'
import { captureContribution } from '../integration/bench-snapshot'
import { findWorkspace, loadWorkspaces, makeMember, makeWorkspace, saveWorkspaces } from '../integration/bench-store'
import { getWorktreeOverlap, invalidateWorktreeOverlap } from './overlap-service'
import { previewWorktreeOverlap } from './overlap-preview'
import { log as _log, warn as _warn } from '../logger'
import { applyRecommendationMembers } from './overlap-apply-members'
import type { WorktreeOverlapAnalysis, WorktreeOverlapApplyPreview, WorktreeOverlapApplyResult, WorktreeOverlapBasis, WorktreeOverlapContext } from '../../shared/types-worktree-overlap'

const TAG = 'worktree.overlap.apply'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Reject selections that cannot be represented as one durable bench member list. */
export function validateOverlapApplySelection(analysis: Pick<WorktreeOverlapAnalysis, 'footprints'>, orderedPaths: string[]): string | undefined {
  if (orderedPaths.length === 0) return 'Select at least one worktree to apply.'
  if (new Set(orderedPaths).size !== orderedPaths.length) return 'Each selected worktree may appear only once.'
  const footprints = new Map(analysis.footprints.map((item) => [item.worktreePath, item]))
  for (const path of orderedPaths) {
    const footprint = footprints.get(path)
    if (!footprint) return 'The selected worktree is no longer available.'
    if (footprint.landed || footprint.incompleteReason || !footprint.tipSha || !footprint.treeHash || !footprint.baseSha || footprint.baseSha === footprint.tipSha) {
      return `${footprint.title ?? footprint.branchName} has no eligible committed contribution.`
    }
  }
  return undefined
}

export async function previewOverlapApply(context: WorktreeOverlapContext, basis: WorktreeOverlapBasis, orderedPaths: string[]): Promise<WorktreeOverlapApplyPreview> {
  return previewOverlapApplyWithAnalysis(await getWorktreeOverlap(context, basis), orderedPaths)
}

export async function previewOverlapApplyWithAnalysis(analysis: WorktreeOverlapAnalysis, orderedPaths: string[]): Promise<WorktreeOverlapApplyPreview> {
  const invalid = validateOverlapApplySelection(analysis, orderedPaths)
  if (invalid) return { orderedPaths, newlyEnrolled: [], enabled: [], disabled: [], orderChanged: [], prediction: 'unavailable', error: invalid }
  const workspace = findWorkspace(loadWorkspaces(), analysis.repoPath, analysis.sourceBranch) ?? makeWorkspace(analysis.repoPath, analysis.sourceBranch)
  const selected = new Set(orderedPaths)
  const simulation = await previewWorktreeOverlap(analysis, orderedPaths)
  const oldOrder = workspace.members.map((member) => member.worktreePath)
  const existing = new Set(oldOrder)
  const proposed = [...orderedPaths, ...oldOrder.filter((path) => !selected.has(path))]
  return {
    orderedPaths,
    newlyEnrolled: orderedPaths.filter((path) => !workspace.members.some((member) => member.worktreePath === path)),
    enabled: workspace.members.filter((member) => selected.has(member.worktreePath) && !member.enabled).map((member) => member.worktreePath),
    disabled: workspace.members.filter((member) => !selected.has(member.worktreePath) && member.enabled).map((member) => member.worktreePath),
    orderChanged: proposed.filter((path, index) => existing.has(path) && oldOrder[index] !== path), prediction: simulation.prediction, error: simulation.error,
  }
}

export async function applyOverlapRecommendation(context: WorktreeOverlapContext, basis: WorktreeOverlapBasis, orderedPaths: string[]): Promise<WorktreeOverlapApplyResult> {
  const repo = repositoryManager.get(context.repoPath)
  return repo.queue.enqueueMutation(async () => {
    invalidateWorktreeOverlap(context.repoPath)
    const analysis = await getWorktreeOverlap(context, basis)
    const invalid = validateOverlapApplySelection(analysis, orderedPaths)
    if (invalid) return { ok: false, error: invalid }
    const preview = await previewOverlapApplyWithAnalysis(analysis, orderedPaths)
    if (preview.prediction !== 'clean') return { ok: false, error: preview.error ?? 'The selected worktrees no longer merge cleanly.' }
    const all = loadWorkspaces()
    const workspaceIndex = all.findIndex((item) => item.repoPath === context.repoPath && item.sourceBranch === analysis.sourceBranch)
    const workspace = workspaceIndex < 0 ? makeWorkspace(context.repoPath, analysis.sourceBranch) : all[workspaceIndex]
    const byPath = new Map(workspace.members.map((member) => [member.worktreePath, member]))
    let newlyEnrolled = 0
    for (const path of orderedPaths) {
      if (byPath.has(path)) continue
      const footprint = analysis.footprints.find((item) => item.worktreePath === path)
      if (!footprint) return { ok: false, error: 'The selected worktree is no longer available.' }
      const contribution = await captureContribution(path, analysis.sourceBranch, footprint.branchName)
      byPath.set(path, makeMember({ worktreePath: path, branchName: footprint.branchName, pinnedSha: contribution.sha, pinnedTreeHash: contribution.treeHash, pinnedBaseSha: contribution.baseSha }))
      newlyEnrolled++
    }
    const transformed = applyRecommendationMembers(workspace.members, orderedPaths, [...byPath.values()].filter((member) => !workspace.members.some((old) => old.worktreePath === member.worktreePath)))
    if (workspaceIndex < 0) all.push({ ...workspace, members: transformed.members })
    else all[workspaceIndex] = { ...workspace, members: transformed.members }
    if (!saveWorkspaces(all)) {
      warn('selection persistence failed', { repo_path: context.repoPath, source_branch: analysis.sourceBranch })
      return { ok: false, error: 'Could not persist bench membership. No selection was applied.' }
    }
    invalidateWorktreeOverlap(context.repoPath)
    log('selection applied', { repo_path: context.repoPath, source_branch: analysis.sourceBranch, enrolled: newlyEnrolled, enabled: transformed.enabled, disabled: transformed.disabled, reordered: transformed.reordered })
    return { ok: true, applied: { newlyEnrolled, enabled: transformed.enabled, disabled: transformed.disabled, reordered: transformed.reordered } }
  }).catch((error) => { warn('selection apply failed', { repo_path: context.repoPath, error: String(error) }); return { ok: false, error: String(error) } })
}
