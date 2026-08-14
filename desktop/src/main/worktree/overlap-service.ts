/** Cached, coalesced worktree-overlap analysis service. */
import { loadWorkspaces, workspacesForRepo } from '../integration/bench-store'
import { getWorktreeInventory } from './inventory-service'
import { runGit } from '../git-runner'
import { collectFootprint } from './overlap-footprint'
import { overlapPair } from './overlap-analysis'
import { mergeTree } from '../integration/merge-tree'
import { recommendWorktreeCohort } from './overlap-recommendation'
import { log as _log, warn as _warn } from '../logger'
import type { WorktreeOverlapAnalysis, WorktreeOverlapBasis, WorktreeOverlapContext, WorktreeOverlapPair } from '../../shared/types-worktree-overlap'

const TAG = 'worktree.overlap'
const CACHE_MS = 5000
const cache = new Map<string, { at: number; value: WorktreeOverlapAnalysis }>()
const inflight = new Map<string, Promise<WorktreeOverlapAnalysis>>()

function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export async function getWorktreeOverlap(
  context: WorktreeOverlapContext,
  basis: WorktreeOverlapBasis,
): Promise<WorktreeOverlapAnalysis> {
  const sourceBranch = context.sourceBranch ?? ''
  const key = `${context.repoPath}\0${sourceBranch}\0${basis}`
  const existing = cache.get(key)
  if (existing && Date.now() - existing.at < CACHE_MS) return existing.value
  const running = inflight.get(key)
  if (running) return running
  const request = compute(context, sourceBranch, basis)
  inflight.set(key, request)
  try {
    const value = await request
    cache.set(key, { at: Date.now(), value })
    return value
  } finally {
    inflight.delete(key)
  }
}

export function invalidateWorktreeOverlap(repoPath: string): void {
  for (const key of cache.keys()) if (key.startsWith(`${repoPath}\0`)) cache.delete(key)
}

async function compute(context: WorktreeOverlapContext, sourceBranch: string, basis: WorktreeOverlapBasis): Promise<WorktreeOverlapAnalysis> {
  const inventory = await getWorktreeInventory(context.repoPath)
  const workspaces = workspacesForRepo(loadWorkspaces(), context.repoPath)
  const workspace = sourceBranch ? workspaces.find((item) => item.sourceBranch === sourceBranch) : workspaces[0]
  const effectiveSource = sourceBranch || workspace?.sourceBranch || inventory.find((item) => item.sourceBranch)?.sourceBranch || ''
  const memberships = new Map((workspace?.members ?? []).map((member, index) => [member.worktreePath, { member, index }]))
  const candidates = inventory.filter((entry) => !effectiveSource || entry.sourceBranch === effectiveSource)
  log('analysis starting', { repo_path: context.repoPath, source_branch: effectiveSource, basis, worktrees: candidates.length })
  const footprints = await Promise.all(candidates.map((entry) => {
    const membership = memberships.get(entry.worktreePath)
    return collectFootprint({ entry, member: membership?.member, basis, order: membership?.index })
  }))
  const pairs: WorktreeOverlapPair[] = []
  for (let leftIndex = 0; leftIndex < footprints.length; leftIndex++) for (let rightIndex = leftIndex + 1; rightIndex < footprints.length; rightIndex++) {
    const left = footprints[leftIndex]
    const right = footprints[rightIndex]
    const pair = overlapPair(left, right)
    if (left.tipSha && right.tipSha) {
      pair.ancestry = await ancestry(context.repoPath, left.tipSha, right.tipSha)
    }
    if (left.tipSha && right.tipSha && pair.sharedFiles.some((file) => file.left.layers.includes('committed') && file.right.layers.includes('committed'))) {
      const merged = await mergeTree(context.repoPath, left.tipSha, right.tipSha)
      pair.prediction = merged.prediction
      pair.conflictPaths = merged.conflictPaths
      pair.error = merged.error
    }
    pairs.push(pair)
  }
  const incompletePaths = footprints.filter((item) => item.incompleteReason).map((item) => item.worktreePath)
  const baseAnalysis = { repoPath: context.repoPath, sourceBranch: effectiveSource, basis, computedAt: Date.now(), footprints, pairs, incompletePaths }
  const recommendation = await recommendWorktreeCohort(baseAnalysis)
  const result = { ...baseAnalysis, recommendation }
  if (incompletePaths.length) warn('analysis has incomplete worktrees', { repo_path: context.repoPath, count: incompletePaths.length })
  log('analysis completed', { repo_path: context.repoPath, source_branch: effectiveSource, pairs: pairs.length, incomplete: incompletePaths.length })
  return result
}

async function ancestry(repoPath: string, left: string, right: string): Promise<'left-contains-right' | 'right-contains-left' | 'diverged' | 'unavailable'> {
  try {
    await runGit(repoPath, ['merge-base', '--is-ancestor', right, left])
    return 'left-contains-right'
  } catch {
    try {
      await runGit(repoPath, ['merge-base', '--is-ancestor', left, right])
      return 'right-contains-left'
    } catch {
      return 'diverged'
    }
  }
}
