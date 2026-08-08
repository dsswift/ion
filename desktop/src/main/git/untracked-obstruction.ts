/**
 * Untracked-obstruction recovery — the precise, git-named-paths alternative to
 * a blind `clean -fd` for surfaces that hold durable, non-disposable content.
 *
 * ── The hazard this exists to fix ────────────────────────────────────────────
 * A merge or rebase step can leave an untracked, non-ignored file behind when
 * git's own abort/checkout logic refuses to delete a path it detects local
 * modifications on (rerere's `autoUpdate` is exactly such a modifier — see
 * `bench-assemble-support.ts`'s `resetBenchToTree` for the identical mechanism
 * confirmed against `git merge --abort`). Confirmed directly against
 * `git rebase --abort` too: an untracked file introduced mid-rebase survives
 * the abort unconditionally. Whatever created the leftover, the SAME class of
 * git refusal follows every later operation that wants to write that path:
 *
 *     error: The following untracked working tree files would be overwritten
 *     by merge (or checkout, or rebase):
 *     	<path1>
 *     	<path2>
 *     Please move or remove them before you merge.
 *
 * ── Why this is NOT the bench's `clean -fd` fix ─────────────────────────────
 * The bench is disposable by design — rebuilt from `(source tip, member list)`
 * on every assembly, so an unconditional, unscoped clean is safe there. A
 * WORKTREE is the opposite: it is the operator's real, durable working
 * directory, and may legitimately hold untracked scratch files (local notes,
 * a temp exploration file an agent wrote) that a blind clean would silently
 * destroy. That would be exactly the "heuristic replacing a precise
 * mechanism" anti-pattern this module exists to avoid.
 *
 * The precise alternative: git's own refusal message names the EXACT paths
 * blocking the operation. This is not a guess — it is git's own determination
 * of collision, printed verbatim. Parsing that list and removing only those
 * paths (after re-verifying each is still untracked, immediately before
 * deletion) can never touch a path git did not explicitly identify, so an
 * operator's own unrelated untracked file elsewhere in the tree is never at
 * risk.
 */
import { unlinkSync } from 'fs'
import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'git.untracked-obstruction'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Parse git's own "would be overwritten by <verb>" refusal into the exact
 * untracked paths it names, or null when the error text is not this shape.
 *
 * The message format is stable across `merge`, `checkout`, and `rebase` (the
 * verb differs, the "The following untracked working tree files..." preamble
 * and the tab-indented path list do not) — confirmed directly against all
 * three during development of this module. Every line between the preamble
 * and the trailing "Please move or remove them..." advice is a path.
 */
export function parseUntrackedObstruction(stderr: string): string[] | null {
  if (!/would be overwritten by (merge|checkout|rebase)/.test(stderr)) return null
  const lines = stderr.split('\n')
  const paths: string[] = []
  let collecting = false
  for (const line of lines) {
    if (/would be overwritten by (merge|checkout|rebase)/.test(line)) {
      collecting = true
      continue
    }
    if (!collecting) continue
    // A tab- or space-indented path line. The advice/blank line that follows
    // the list is neither indented the same way nor a plausible path, so
    // stopping at the first non-indented line is exact for git's own format.
    if (/^\s+\S/.test(line)) {
      paths.push(line.trim())
    } else if (paths.length > 0) {
      break
    }
  }
  return paths.length > 0 ? paths : null
}

/**
 * Untracked status for one path, or null when the probe itself failed.
 *
 * `git status --porcelain -- <path>` reports `??` for a genuinely untracked
 * path and nothing at all for a path git does not see as changed (tracked and
 * clean, or absent). Both are treated as "not safely removable" by the
 * caller — this function answers only "is it untracked right now", the final
 * guard against acting on a stale error message if the path's status changed
 * between the failure and the retry.
 */
async function isUntracked(directory: string, path: string): Promise<boolean> {
  try {
    const status = await runGit(directory, ['status', '--porcelain', '--', path])
    return status.trim().startsWith('??')
  } catch (err) {
    warn('could not verify untracked status before removal', { directory, path, error: String(err) })
    return false
  }
}

export interface RetryAfterClearingResult<T> {
  /** The eventual result, whether from the first attempt or the retry. */
  result: T
  /** True when a retry ran (the first attempt hit the exact obstruction shape). */
  retried: boolean
  /** Paths actually removed before the retry. Empty when no retry ran. */
  removedPaths: string[]
}

/**
 * Run `attempt` once. If it throws git's own "would be overwritten" error,
 * parse the exact paths it names, re-verify each is still untracked, remove
 * only those, and retry `attempt` exactly once more.
 *
 * Every path considered is logged individually — whether removed, or skipped
 * because it was no longer untracked by the time this ran (a stale error, or
 * the operator/an agent committed or otherwise resolved it in the interim).
 * This never fails silently: a path that cannot be safely removed is logged
 * and left in place, and the original error propagates from the (failed)
 * retry rather than being swallowed.
 */
export async function retryAfterClearingBlockingUntracked<T>(
  directory: string,
  attempt: () => Promise<T>,
): Promise<RetryAfterClearingResult<T>> {
  try {
    const result = await attempt()
    return { result, retried: false, removedPaths: [] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const blocking = parseUntrackedObstruction(message)
    if (!blocking) throw err

    log('untracked obstruction detected, attempting precise removal', {
      directory, blocking_paths: blocking,
    })

    const removedPaths: string[] = []
    for (const path of blocking) {
      const stillUntracked = await isUntracked(directory, path)
      if (!stillUntracked) {
        log('obstruction path no longer untracked, leaving it in place', { directory, path })
        continue
      }
      try {
        unlinkSync(`${directory}/${path}`)
        removedPaths.push(path)
        log('removed untracked path named by git as blocking', { directory, path })
      } catch (rmErr) {
        warn('could not remove untracked path named by git as blocking', {
          directory, path, error: String(rmErr),
        })
      }
    }

    if (removedPaths.length === 0) {
      warn('untracked obstruction detected but nothing could be safely removed', {
        directory, blocking_paths: blocking,
      })
      throw err
    }

    log('retrying operation after removing exact blocking paths', {
      directory, removed_paths: removedPaths,
    })
    const result = await attempt()
    return { result, retried: true, removedPaths }
  }
}
