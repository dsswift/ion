/**
 * Worktree title backfill — names the worktrees that predate auto-titling.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Auto-titling names a worktree from the FIRST prompt sent inside it, which
 * means worktrees created before the feature (or ones nobody has prompted in
 * since) keep their machine slugs (`ion-77eb0fbc`) indefinitely — the operator
 * saw exactly that: new worktrees earned names while the four pre-existing
 * rows stayed slugs. The backfill names them from the work they already
 * contain: their unlanded commit subjects, which describe the work as
 * precisely as a first prompt does.
 *
 * ── When it runs ────────────────────────────────────────────────────────────
 * Fire-and-forget off the inventory read — the moment the panel learns a
 * registered worktree has no title is the moment to fix it. The inventory
 * itself stays read-only and fast; titles land asynchronously and are
 * announced through the same broadcast + iOS push the first-prompt path uses,
 * so rows update live when generation completes.
 *
 * ── What is skipped (each with a logged reason) ─────────────────────────────
 * - unregistered worktrees: no registry row to store the title on;
 * - already-titled worktrees: the durable idempotency guard;
 * - worktrees with no unlanded commits: nothing to describe — their title
 *   comes from their first prompt, like any fresh worktree;
 * - mid-operation worktrees: subjects are unavailable/meaningless mid-rebase
 *   (the inventory skips their appraisal, so no subjects arrive here anyway).
 *
 * ── One attempt per worktree per desktop run ────────────────────────────────
 * A failed or empty generation (engine unreachable, no titling model
 * configured) must not re-fire an LLM call on every inventory poll — the
 * panel refreshes on every git change. The attempted set is in-memory (same
 * lifetime pattern as provision-state): a restart retries, which is the right
 * cadence for "the titling model was misconfigured yesterday".
 */
import { engineBridge } from '../state'
import { log as _log, warn as _warn } from '../logger'
import { lookupWorktreeRegistration, setWorktreeTitle } from './inventory'
import { announceWorktreeTitle, MAX_TITLE_INPUT_CHARS } from './title-announce'

const TAG = 'worktree.title'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** One backfill candidate: an inventory entry plus its appraisal subjects. */
export interface BackfillCandidate {
  worktreePath: string
  /** Registry title, when one exists (the inventory already looked it up). */
  title?: string
  /** In-progress operation, when any — mid-rebase worktrees are skipped. */
  operationState?: string
  /** Unlanded commit subjects, newest first, from the inventory's appraisal. */
  unlandedSubjects: string[]
}

/** Worktrees already attempted this desktop run (success or failure). */
const attempted = new Set<string>()

/** Test seam: forget attempts so a fixture can exercise the retry boundary. */
export function _resetBackfillForTests(): void {
  attempted.clear()
}

/**
 * Backfill titles for every untitled registered worktree in `candidates`.
 *
 * Fire-and-forget from the caller's perspective; returns the applied titles
 * for tests. Each candidate is judged independently so one failure never
 * blocks the others.
 */
export async function maybeBackfillWorktreeTitles(
  repoPath: string,
  candidates: BackfillCandidate[],
): Promise<Array<{ worktreePath: string; title: string }>> {
  const applied: Array<{ worktreePath: string; title: string }> = []

  for (const c of candidates) {
    if (c.title) continue // titled — the common case, not worth a log line per poll
    if (attempted.has(c.worktreePath)) continue // one attempt per run

    if (c.operationState) {
      log('backfill skipped: operation in progress', {
        worktree_path: c.worktreePath, operation: c.operationState,
      })
      continue
    }

    const registration = lookupWorktreeRegistration(c.worktreePath)
    if (!registration) {
      log('backfill skipped: not a registered worktree', { worktree_path: c.worktreePath })
      continue
    }
    if (registration.title) {
      // The registry is the durable guard; the inventory entry can lag one
      // poll behind a just-applied title.
      continue
    }

    if (c.unlandedSubjects.length === 0) {
      log('backfill skipped: no unlanded commits to describe', { worktree_path: c.worktreePath })
      continue
    }

    attempted.add(c.worktreePath)

    // Newest-first: the most recent subject is the best one-line description
    // of where the work ended up, and truncation should cut old history.
    const input = c.unlandedSubjects.join('\n').slice(0, MAX_TITLE_INPUT_CHARS)
    log('backfill generating', {
      worktree_path: c.worktreePath,
      subjects: c.unlandedSubjects.length,
      input_len: input.length,
    })

    let title = ''
    try {
      title = (await engineBridge.generateTitle(input)).trim()
    } catch (err) {
      warn('backfill generation failed; the worktree keeps its slug this run', {
        worktree_path: c.worktreePath, error: String(err),
      })
      continue
    }
    if (!title) {
      // The engine returns "" when no titling model is configured. A
      // legitimate configuration, not an error — say so and move on.
      log('backfill produced no title (no titling model configured?)', {
        worktree_path: c.worktreePath,
      })
      continue
    }

    setWorktreeTitle(c.worktreePath, title)
    log('backfill applied', { worktree_path: c.worktreePath, title })
    await announceWorktreeTitle(registration.repoPath || repoPath, c.worktreePath, title)
    applied.push({ worktreePath: c.worktreePath, title })
  }

  return applied
}
