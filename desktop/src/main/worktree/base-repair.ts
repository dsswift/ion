/**
 * Base repair — self-healing the registry's stored `baseSha` against reality
 * before a sync trusts it.
 *
 * ── The incident this fixes ─────────────────────────────────────────────────
 * A worktree's sync hit a conflict; an AI assist opened in the conflicted
 * directory finished the rebase with raw `git rebase --continue` calls (Bash,
 * not Ion's own sync code). That is a completely legitimate way to finish a
 * rebase — but it means `syncWorktreeFromSource`'s own success path, the ONLY
 * place that calls `setWorktreeBase` (see registry.ts), never ran. The
 * registry kept naming the worktree's ORIGINAL cut point as its base, even
 * though HEAD was now genuinely built on the source branch's current tip.
 *
 * Fifteen seconds later, Land's `syncFirst` step ran ANOTHER sync. It read the
 * stale `baseSha`, and the existing validity check —
 * `merge-base --is-ancestor <storedBase> HEAD` — passed, because an old
 * commit on an append-only source branch stays an ancestor of HEAD forever.
 * That check proves the stored base is *reachable*; it does not prove it is
 * *current*. So the sync computed its replay range as `storedBase..HEAD`,
 * which — because storedBase now predates the tip HEAD is actually built on —
 * included every commit the source branch had gained since the OLD cut point,
 * not just the worktree's own work. git dropped the ones already upstream and
 * then re-hit the exact same file's conflict, but in a different replay
 * sequence, so rerere's exact-conflict-text cache did not match: the operator
 * had to resolve the identical file a second time.
 *
 * ── The fix: derive truth, don't just validate a stored guess ───────────────
 * `git merge-base HEAD <source>` is an exact, deterministic graph computation:
 * it names the tightest common ancestor of HEAD and the source tip, which is
 * PRECISELY the base a completed rebase (by any means) leaves a worktree on.
 * Recomputing it before every sync and repairing the registry when it has
 * moved past the stored value closes the gap regardless of what completed the
 * prior rebase — Ion's own auto-continue, an AI assist running raw git, or
 * the operator finishing it by hand. No new call site has to remember to call
 * `setWorktreeBase`; the stored fact self-corrects at the point of use.
 */
import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'
import { setWorktreeBase } from './registry'

const TAG = 'worktree.base-repair'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Repair a worktree's stored base against the true current fork point, and
 * return the base a sync should actually use.
 *
 * `storedBase` is trusted as-is when it already equals the true merge-base
 * (the common case: nothing has synced this worktree out-of-band since it was
 * last recorded), or when it is not an ancestor of the true merge-base at all
 * (a corrupted or unrelated record — the caller's existing
 * ancestor-of-HEAD check decides whether that is usable, same as before this
 * repair step existed). It is repaired — and the registry updated to match —
 * only when it is a strict ancestor of the true merge-base, which is exactly
 * the "stale but still technically reachable" case the incident above hit.
 *
 * Read-only on failure: an unreadable `merge-base` degrades to returning
 * `storedBase` unchanged, so a repair that cannot be computed never blocks or
 * corrupts the sync it is trying to make more precise.
 */
export async function repairStaleBase(
  worktreePath: string,
  sourceBranch: string,
  storedBase: string,
): Promise<string> {
  let trueBase: string
  try {
    trueBase = (await runGit(worktreePath, ['merge-base', 'HEAD', sourceBranch])).trim()
  } catch (err) {
    warn('could not compute true fork point, using stored base unrepaired', {
      worktree_path: worktreePath, source_branch: sourceBranch, stored_base: storedBase.slice(0, 7), error: String(err),
    })
    return storedBase
  }

  if (trueBase === storedBase) return storedBase

  try {
    // Is the recorded base strictly BEHIND the true fork point? That is the
    // signature of staleness: HEAD already sits on a later point of the
    // source branch than the registry believes, most likely because a
    // previous rebase was completed outside this codebase's own sync path.
    await runGit(worktreePath, ['merge-base', '--is-ancestor', storedBase, trueBase])
  } catch {
    // Not an ancestor of the true fork point either — an unrelated or
    // corrupted record. Leave it exactly as it was; the caller's own
    // ancestor-of-HEAD check is what decides whether THAT is usable.
    return storedBase
  }

  log('stored base was stale, repairing to the true fork point', {
    worktree_path: worktreePath,
    source_branch: sourceBranch,
    stored_base: storedBase.slice(0, 7),
    true_base: trueBase.slice(0, 7),
  })
  if (!setWorktreeBase(worktreePath, trueBase)) {
    warn('base repair computed but registry persist failed', { worktree_path: worktreePath })
  }
  return trueBase
}
