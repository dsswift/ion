/**
 * Integration-bench write guard — the UI half of "a bench refuses history
 * writes".
 *
 * ── What this protects ──────────────────────────────────────────────────────
 * A bench worktree is REBUILDABLE. Every rebuild recreates its branch from
 * scratch (`bench-rebuild.ts`):
 *
 *     git switch -C ion/bench/<slug> <sourceBranch> --discard-changes
 *     git merge --no-ff <pinnedSha>   # per member, in order
 *
 * So a commit made in a bench is destroyed by the next rebuild, and a push
 * would publish a synthetic merge of other people's in-flight work. Neither is
 * recoverable. The git panel is fully usable inside a bench conversation, so
 * without this guard the commit button in a bench tab is a silent data-loss
 * affordance.
 *
 * ── Why this exists separately from ion-meta's bench-gate ───────────────────
 * There are two independent actors that can write git history in a bench: an
 * AGENT running a Bash tool call, and the OPERATOR clicking a git-panel button.
 * ion-meta's `bench-gate.ts` covers the agent; this covers the operator. They
 * cannot share code — ion-meta ships as a standalone extension bundle with no
 * desktop or engine imports — so the containment rule is stated in both places
 * on purpose, and both carry a test pinning identical behaviour (root match,
 * subdirectory match, sibling-prefix rejection).
 *
 * ── What is NOT guarded ─────────────────────────────────────────────────────
 * Reading, building, testing, staging, and patch-applying all stay open. The
 * bench exists to build and test a combination of in-flight work; over-blocking
 * would defeat its only purpose. Index and working-tree operations are already
 * reset by `--discard-changes` on the next rebuild, so they lose nothing that
 * was not already transient.
 *
 * See docs/architecture/adr/024-integration-workspace.md § "The bench refuses
 * history writes".
 */
import { sep } from 'path'
import { loadWorkspaces } from './bench-store'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'bench.guard'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** The refusal payload. Matches the `{ ok, error }` shape every git IPC returns. */
export interface BenchRefusal {
  ok: false
  error: string
}

/**
 * Resolve which bench contains `directory`, or null when none does.
 *
 * The separator is REQUIRED on the descendant check. A bare
 * `directory.startsWith(benchPath)` would also match a sibling whose name
 * merely begins with the bench path — `…/project-josh-other` against
 * `…/project-josh` — refusing commits in an unrelated worktree. A false
 * refusal in the place the operator is doing real work is worse than the guard
 * not firing, so the check is exact-or-separator-prefixed, never bare.
 *
 * Exported because `bench-ops.isBenchDirectory` delegates here: the main
 * process must not carry two different answers to "is this a bench".
 */
export function resolveBenchFor(directory: string): string | null {
  if (!directory) return null
  try {
    for (const ws of loadWorkspaces()) {
      if (!ws.benchPath) continue
      if (directory === ws.benchPath) return ws.benchPath
      if (directory.startsWith(ws.benchPath + sep)) return ws.benchPath
    }
  } catch (err) {
    // loadWorkspaces already handles a missing or corrupt file by returning an
    // empty list, so reaching here means something more unusual. Fail OPEN and
    // say so: refusing every git write because the workspace record could not
    // be read would block legitimate commits in ordinary worktrees, which is a
    // worse failure than briefly missing the guard. ion-meta's gate enforces
    // the same rule independently for agent-driven writes.
    warn('workspace lookup failed, allowing the operation', {
      directory,
      error: String(err),
    })
    return null
  }
  return null
}

/** True when `directory` is a bench root or any descendant of one. */
export function isInsideBench(directory: string): boolean {
  return resolveBenchFor(directory) !== null
}

/**
 * Refuse a history-writing git operation inside a bench.
 *
 * Returns the refusal payload when `directory` is inside a bench, or `null`
 * when the operation may proceed. Callers return the payload directly:
 *
 *     const refusal = benchGuard(directory, 'commit')
 *     if (refusal) return refusal
 *
 * Both outcomes log. A refusal the operator does not understand looks like a
 * broken button, so the block is logged at info with the bench path and the
 * verb; the pass is logged at debug because it is on the path of every git
 * operation.
 *
 * The message names the remediation, not just the refusal: the fix belongs in
 * the member worktree that owns the file, because that is the only place a
 * commit survives a rebuild.
 */
export function benchGuard(directory: string, operation: string): BenchRefusal | null {
  const benchPath = resolveBenchFor(directory)
  if (!benchPath) {
    log('git operation allowed, not a bench', { directory, operation })
    return null
  }

  const error = [
    `Cannot ${operation} in an integration bench.`,
    'The bench branch is recreated from scratch on every rebuild, so a commit here would be destroyed and a push would publish a synthetic merge of other people\'s in-flight work.',
    'Commit this change in the member worktree that owns the file, then update that member in the bench.',
  ].join(' ')

  log('git operation refused, directory is a bench', { directory, operation, bench_path: benchPath })
  return { ok: false, error }
}
