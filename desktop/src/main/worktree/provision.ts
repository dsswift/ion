/**
 * Worktree provisioning orchestrator.
 *
 * Runs the whole sequence for one worktree: read the project's manifest, seed
 * each declared directory through the ladder, reconcile anything stale, then
 * run the project's own setup recipe.
 *
 * ── Asynchronous by design ──────────────────────────────────────────────────
 * The worktree is created and usable before this starts. Provisioning runs
 * behind it and reports progress through `provisionState`, so the operator can
 * open a conversation immediately rather than waiting on an install. On the
 * clone rung the whole thing is sub-second; on the build rung it is watchable.
 *
 * ── Failure is non-fatal and legible ────────────────────────────────────────
 * A failed entry does not abort the rest: later entries still run, and the
 * worktree ends in `failed` carrying the reason. A usable worktree with a
 * broken `node_modules` is strictly better than no worktree, and the operator
 * has an explicit re-provision verb. Nothing here ever destroys anything.
 *
 * ── Serialized per repo ─────────────────────────────────────────────────────
 * Two worktrees created back to back must not run two `npm ci` processes
 * against the same package cache. A per-repo queue makes them wait, matching
 * the serialization the land path already applies for the same reason.
 */
import { readProvisionManifest } from './provision-manifest'
import { seedEntry, reconcileStale, type SeedResult } from './provision-seed'
import { runProvisionCommand } from './provision-run'
import { log as _log, warn as _warn } from '../logger'
import type { WorktreeProvisionState } from '../../shared/types'

const TAG = 'worktree.provision'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export interface ProvisionOutcome {
  state: WorktreeProvisionState
  results: SeedResult[]
  /** Populated when something failed; the operator-facing explanation. */
  error?: string
}

/** Observer for state transitions, so the UI can follow along live. */
export type ProvisionProgress = (state: WorktreeProvisionState, detail?: string) => void

/**
 * Per-repo serialization. Each repo's provisioning runs are chained onto one
 * promise so concurrent worktree creations queue instead of colliding.
 */
const repoQueues = new Map<string, Promise<unknown>>()

/** Test seam: clear queued work between cases. */
export function _resetProvisionQueuesForTests(): void {
  repoQueues.clear()
}

/**
 * Provision `worktreePath`, cut from `repoPath`.
 *
 * Resolves with the final state. Never rejects: every failure is captured into
 * the outcome, because a rejected promise on a fire-and-forget provisioning run
 * would be an unhandled rejection rather than an observable state.
 */
export function provisionWorktree(
  repoPath: string,
  worktreePath: string,
  onProgress?: ProvisionProgress,
): Promise<ProvisionOutcome> {
  const prior = repoQueues.get(repoPath) ?? Promise.resolve()
  const run = prior
    // The previous run already reported its own outcome (provisionState plus its
    // own log lines). Rethrowing here would make one worktree's failure block
    // the next worktree's provisioning entirely.
    .catch(() => undefined) // silent-ok: prior run already logged its own failure
    .then(() => provisionNow(repoPath, worktreePath, onProgress))
  repoQueues.set(repoPath, run)
  return run
}

async function provisionNow(
  repoPath: string,
  worktreePath: string,
  onProgress?: ProvisionProgress,
): Promise<ProvisionOutcome> {
  const startedAt = Date.now()
  const emit = (state: WorktreeProvisionState, detail?: string): void => {
    onProgress?.(state, detail)
  }

  const plan = readProvisionManifest(repoPath)
  if (plan.seed.length === 0 && !plan.setup) {
    // No manifest, or an empty one. Provisioning is a no-op and the worktree is
    // exactly what git produced — the purely-additive guarantee.
    log('nothing to provision', { repo_path: repoPath, worktree_path: worktreePath })
    emit('ready')
    return { state: 'ready', results: [] }
  }

  log('provisioning started', {
    repo_path: repoPath,
    worktree_path: worktreePath,
    seed_count: plan.seed.length,
    has_setup: !!plan.setup,
  })
  emit('seeding')

  const results: SeedResult[] = []
  const failures: string[] = []

  for (const entry of plan.seed) {
    const result = await seedEntry(repoPath, worktreePath, entry)
    results.push(result)
    if (result.strategy === 'failed') {
      failures.push(`${entry.path}: ${result.reason ?? 'unknown'}`)
      // Deliberately continue: one broken dependency tree must not deprive the
      // worktree of the others.
      continue
    }
    // A cloned or copied tree can predate this worktree's own lockfile. Only
    // those rungs can be stale — a `build` just reconciled by construction.
    if (result.strategy === 'clone' || result.strategy === 'copy') {
      emit('building', entry.path)
      await reconcileStale(repoPath, worktreePath, entry)
    }
  }

  if (plan.setup) {
    emit('building', 'setup')
    const setupResult = await runProvisionCommand(plan.setup, worktreePath)
    if (!setupResult.ok) {
      failures.push(`setup: ${setupResult.error ?? 'unknown'}`)
    }
  }

  const elapsedMs = Date.now() - startedAt
  if (failures.length > 0) {
    const error = failures.join('; ')
    warn('provisioning finished with failures', {
      repo_path: repoPath, worktree_path: worktreePath, elapsed_ms: elapsedMs, failures,
    })
    emit('failed', error)
    return { state: 'failed', results, error }
  }

  log('provisioning complete', {
    repo_path: repoPath,
    worktree_path: worktreePath,
    elapsed_ms: elapsedMs,
    strategies: results.map((r) => `${r.path}=${r.strategy}`),
  })
  emit('ready')
  return { state: 'ready', results }
}
