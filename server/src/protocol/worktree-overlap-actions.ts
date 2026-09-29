/**
 * `worktree.overlap.*` `studio_action`s: the Worktree Overlap visualizer's
 * analysis, solver and apply verbs, moved from the desktop's
 * `ipc/worktree-overlap.ts`.
 *
 * The IPC handlers resolved the repository from the calling window
 * (`worktreeOverlapContext(event.sender.id)`). A `studio_action` has no
 * window, so every verb here takes the context explicitly as its first
 * argument: `{ repoPath, sourceBranch? }`, the same record the overlap
 * window is opened with. Opening the window itself stays native
 * (`WORKTREE_OVERLAP_OPEN`); the work behind it is the server's.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Analysis, preview and the solver read git state: `conversations:read`.
 * Apply rewrites worktree enrolment and bench membership: `git:write`.
 */
import type { Scope } from '@ion/shared/studio-wire/types'
import type { WorktreeOverlapAnalysis, WorktreeOverlapBasis, WorktreeOverlapContext } from '@ion/shared/types-worktree-overlap'
import { isValidProjectPath } from '../ipc-validation'
import { runGit } from '../git/git-runner'
import { getWorktreeOverlap } from '../worktree/overlap-service'
import { previewWorktreeOverlap } from '../worktree/overlap-preview'
import { applyOverlapRecommendation, previewOverlapApply } from '../worktree/overlap-apply'
import { reorderCurrentSelection, solveWorktreeOverlap } from '../worktree/overlap-recommendation'
import { log as _log, warn as _warn } from '../logger'
import type { MiscActionSpec } from './misc-actions'
import type { Connection } from './connection'

const TAG = 'worktree-overlap-actions'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

function validContext(value: unknown): value is WorktreeOverlapContext {
  const ctx = value as { repoPath?: unknown; sourceBranch?: unknown } | null
  return typeof ctx?.repoPath === 'string' && isValidProjectPath(ctx.repoPath) && (ctx.sourceBranch === undefined || typeof ctx.sourceBranch === 'string')
}
function validBasis(value: unknown): value is WorktreeOverlapBasis { return value === 'live' || value === 'pins' }
function validPath(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length < 4096 && !/[\0\r\n]/.test(value) }
function validOptionalPaths(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 64 && value.every(validPath) && new Set(value).size === value.length }
function validPaths(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(validPath) && new Set(value).size === value.length }
function pathsKnown(analysis: WorktreeOverlapAnalysis, paths: string[]): boolean {
  const known = new Set(analysis.footprints.map((item) => item.worktreePath))
  return paths.every((path) => known.has(path))
}

const UNKNOWN_PATHS = 'Selected worktree is not available in this overlap analysis.'

/**
 * The IPC handlers answered `{ error }` (or `{ ok: false, error }` for
 * apply) rather than throwing, and the visualizer renders that shape. Kept:
 * a validation refusal and a git failure both reach the operator as text in
 * the window, not as a failed action.
 */
function wrap(name: string, requiredScope: Scope, run: (conn: Connection, args: unknown[]) => Promise<unknown>): MiscActionSpec {
  return {
    requiredScope,
    handler: async (conn, args) => {
      try {
        return { ok: true, value: await run(conn, args) }
      } catch (err) {
        warn('overlap action threw', { connection_id: conn.id, action: name, error: String(err) })
        return { ok: false, error: { code: 'action_failed', message: String(err) } }
      }
    },
  }
}

export const WORKTREE_OVERLAP_ACTIONS: Record<string, MiscActionSpec> = {
  // [ctx, basis] → { analysis } | { error }
  'worktree.overlap.analyze': wrap('worktree.overlap.analyze', 'conversations:read', async (_conn, [ctx, basis]) => {
    if (!validContext(ctx) || !validBasis(basis)) return { error: 'Invalid overlap analysis request.' }
    try {
      const analysis = await getWorktreeOverlap(ctx, basis)
      log('analysis served', { repo_path: ctx.repoPath, source_branch: analysis.sourceBranch, basis })
      return { analysis }
    } catch (error) { warn('analysis failed', { repo_path: ctx.repoPath, error: String(error) }); return { error: String(error) } }
  }),

  // [ctx, basis, paths] → { preview } | { error }
  'worktree.overlap.preview': wrap('worktree.overlap.preview', 'conversations:read', async (_conn, [ctx, basis, paths]) => {
    if (!validContext(ctx) || !validBasis(basis) || !validPaths(paths)) return { error: 'Invalid overlap preview request.' }
    try {
      const analysis = await getWorktreeOverlap(ctx, basis)
      if (!pathsKnown(analysis, paths)) return { error: UNKNOWN_PATHS }
      return { preview: await previewWorktreeOverlap(analysis, paths) }
    } catch (error) { warn('preview failed', { repo_path: ctx.repoPath, error: String(error) }); return { error: String(error) } }
  }),

  // [ctx, basis, keptPaths] → { solver } | { error }
  'worktree.overlap.solve': wrap('worktree.overlap.solve', 'conversations:read', async (_conn, [ctx, basis, keptPaths]) => {
    if (!validContext(ctx) || !validBasis(basis) || !validOptionalPaths(keptPaths)) return { error: 'Invalid overlap solver request.' }
    try {
      const analysis = await getWorktreeOverlap(ctx, basis)
      if (!pathsKnown(analysis, keptPaths)) return { error: UNKNOWN_PATHS }
      return { solver: await solveWorktreeOverlap(analysis, keptPaths) }
    } catch (error) { warn('solver failed', { repo_path: ctx.repoPath, error: String(error) }); return { error: String(error) } }
  }),

  // [ctx, basis, paths] → { cohort } | { error }
  'worktree.overlap.autoOrder': wrap('worktree.overlap.autoOrder', 'conversations:read', async (_conn, [ctx, basis, paths]) => {
    if (!validContext(ctx) || !validBasis(basis) || !validPaths(paths)) return { error: 'Invalid auto-order request.' }
    try {
      const analysis = await getWorktreeOverlap(ctx, basis)
      if (!pathsKnown(analysis, paths)) return { error: UNKNOWN_PATHS }
      const base = (await runGit(ctx.repoPath, ['rev-parse', analysis.sourceBranch])).trim()
      return { cohort: await reorderCurrentSelection(analysis, base, paths, analysis.recommendation.kind) }
    } catch (error) { warn('auto-order failed', { repo_path: ctx.repoPath, error: String(error) }); return { error: String(error) } }
  }),

  // [ctx, basis, paths] → { preview } | { error }
  'worktree.overlap.applyPreview': wrap('worktree.overlap.applyPreview', 'conversations:read', async (_conn, [ctx, basis, paths]) => {
    if (!validContext(ctx) || !validBasis(basis) || !validPaths(paths)) return { error: 'Invalid selection preview request.' }
    try {
      const analysis = await getWorktreeOverlap(ctx, basis)
      if (!pathsKnown(analysis, paths)) return { error: UNKNOWN_PATHS }
      return { preview: await previewOverlapApply(ctx, basis, paths) }
    } catch (error) { warn('apply preview failed', { repo_path: ctx.repoPath, error: String(error) }); return { error: String(error) } }
  }),

  // [ctx, basis, paths] → WorktreeOverlapApplyResult
  'worktree.overlap.apply': wrap('worktree.overlap.apply', 'git:write', async (_conn, [ctx, basis, paths]) => {
    if (!validContext(ctx) || !validBasis(basis) || !validPaths(paths)) return { ok: false, error: 'Invalid selection apply request.' }
    try {
      const analysis = await getWorktreeOverlap(ctx, basis)
      if (!pathsKnown(analysis, paths)) return { ok: false, error: UNKNOWN_PATHS }
      return applyOverlapRecommendation(ctx, basis, paths)
    } catch (error) { warn('apply failed', { repo_path: ctx.repoPath, error: String(error) }); return { ok: false, error: String(error) } }
  }),
}
