/** IPC for the desktop-local Worktree Overlap visualizer. */
import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { isValidProjectPath } from '../ipc-validation'
import { runGit } from '../git-runner'
import { getWorktreeOverlap } from '../worktree/overlap-service'
import { previewWorktreeOverlap } from '../worktree/overlap-preview'
import { applyOverlapRecommendation, previewOverlapApply } from '../worktree/overlap-apply'
import { openWorktreeOverlapWindow, worktreeOverlapContext } from '../worktree-overlap-window'
import { log as _log, warn as _warn } from '../logger'
import { reorderCurrentSelection, solveWorktreeOverlap } from '../worktree/overlap-recommendation'
import type { WorktreeOverlapAnalysis } from '../../shared/types-worktree-overlap'

const TAG = 'worktree.overlap.ipc'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export function registerWorktreeOverlapIpc(): void {
  ipcMain.on(IPC.WORKTREE_OVERLAP_OPEN, (_event, input: unknown) => {
    const request = input as { repoPath?: unknown; sourceBranch?: unknown }
    if (typeof request?.repoPath !== 'string' || !isValidProjectPath(request.repoPath) || (request.sourceBranch !== undefined && typeof request.sourceBranch !== 'string')) {
      warn('open refused: invalid context')
      return
    }
    openWorktreeOverlapWindow({ repoPath: request.repoPath, sourceBranch: request.sourceBranch })
  })
  ipcMain.handle(IPC.WORKTREE_OVERLAP_CONTEXT, (event) => worktreeOverlapContext(event.sender.id))
  ipcMain.handle(IPC.WORKTREE_OVERLAP_ANALYZE, async (event, basis: unknown) => {
    const context = worktreeOverlapContext(event.sender.id)
    if (!context || !validBasis(basis)) return { error: 'Invalid overlap analysis request.' }
    try {
      const analysis = await getWorktreeOverlap(context, basis)
      log('analysis served', { repo_path: context.repoPath, source_branch: analysis.sourceBranch, basis })
      return { analysis }
    } catch (error) { warn('analysis failed', { repo_path: context.repoPath, error: String(error) }); return { error: String(error) } }
  })
  ipcMain.handle(IPC.WORKTREE_OVERLAP_PREVIEW, async (event, basis: unknown, paths: unknown) => {
    const context = worktreeOverlapContext(event.sender.id)
    if (!context || !validBasis(basis) || !validPaths(paths)) return { error: 'Invalid overlap preview request.' }
    try {
      const analysis = await getWorktreeOverlap(context, basis)
      if (!pathsKnown(analysis, paths)) return { error: 'Selected worktree is not available in this overlap analysis.' }
      return { preview: await previewWorktreeOverlap(analysis, paths) }
    } catch (error) { warn('preview failed', { repo_path: context.repoPath, error: String(error) }); return { error: String(error) } }
  })
  ipcMain.handle(IPC.WORKTREE_OVERLAP_SOLVE, async (event, basis: unknown, keptPaths: unknown) => {
    const context = worktreeOverlapContext(event.sender.id)
    if (!context || !validBasis(basis) || !validOptionalPaths(keptPaths)) return { error: 'Invalid overlap solver request.' }
    try {
      const analysis = await getWorktreeOverlap(context, basis)
      if (!pathsKnown(analysis, keptPaths)) return { error: 'Selected worktree is not available in this overlap analysis.' }
      return { solver: await solveWorktreeOverlap(analysis, keptPaths) }
    } catch (error) { warn('solver failed', { repo_path: context.repoPath, error: String(error) }); return { error: String(error) } }
  })
  ipcMain.handle(IPC.WORKTREE_OVERLAP_AUTO_ORDER, async (event, basis: unknown, paths: unknown) => {
    const context = worktreeOverlapContext(event.sender.id)
    if (!context || !validBasis(basis) || !validPaths(paths)) return { error: 'Invalid auto-order request.' }
    try {
      const analysis = await getWorktreeOverlap(context, basis)
      if (!pathsKnown(analysis, paths)) return { error: 'Selected worktree is not available in this overlap analysis.' }
      const base = (await runGit(context.repoPath, ['rev-parse', analysis.sourceBranch])).trim()
      return { cohort: await reorderCurrentSelection(analysis, base, paths, analysis.recommendation.kind) }
    } catch (error) { warn('auto-order failed', { repo_path: context.repoPath, error: String(error) }); return { error: String(error) } }
  })
  ipcMain.handle(IPC.WORKTREE_OVERLAP_APPLY_PREVIEW, async (event, basis: unknown, paths: unknown) => {
    const context = worktreeOverlapContext(event.sender.id)
    if (!context || !validBasis(basis) || !validPaths(paths)) return { error: 'Invalid selection preview request.' }
    try {
      const analysis = await getWorktreeOverlap(context, basis)
      if (!pathsKnown(analysis, paths)) return { error: 'Selected worktree is not available in this overlap analysis.' }
      return { preview: await previewOverlapApply(context, basis, paths) }
    } catch (error) { warn('apply preview failed', { repo_path: context.repoPath, error: String(error) }); return { error: String(error) } }
  })
  ipcMain.handle(IPC.WORKTREE_OVERLAP_APPLY, async (event, basis: unknown, paths: unknown) => {
    const context = worktreeOverlapContext(event.sender.id)
    if (!context || !validBasis(basis) || !validPaths(paths)) return { ok: false, error: 'Invalid selection apply request.' }
    try {
      const analysis = await getWorktreeOverlap(context, basis)
      if (!pathsKnown(analysis, paths)) return { ok: false, error: 'Selected worktree is not available in this overlap analysis.' }
      return applyOverlapRecommendation(context, basis, paths)
    } catch (error) { warn('apply failed', { repo_path: context.repoPath, error: String(error) }); return { ok: false, error: String(error) } }
  })
}

function validBasis(value: unknown): value is 'live' | 'pins' { return value === 'live' || value === 'pins' }
function validOptionalPaths(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 64 && value.every(validPath) && new Set(value).size === value.length }
function validPaths(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(validPath) && new Set(value).size === value.length }
function validPath(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length < 4096 && !/[\0\r\n]/.test(value) }
function pathsKnown(analysis: WorktreeOverlapAnalysis, paths: string[]): boolean {
  const known = new Set(analysis.footprints.map((item) => item.worktreePath))
  return paths.every((path) => known.has(path))
}
