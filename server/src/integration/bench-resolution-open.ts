/**
 * The bench's own open conflict-resolution merge, read from git.
 *
 * A resolve-once merge lives in the bench worktree, not on a member record.
 * The member it was opened for can be re-pinned or removed while it is open,
 * and the merge still refuses every assembly until it is continued or aborted.
 * So "is a resolution open" is asked of the bench directory, and the answer is
 * what keeps the merge reachable when no member row reports a conflict.
 */
import { existsSync } from 'node:fs'
import { probeOperationState } from '../git/operation-state'
import { runGit } from '../git/git-runner'
import { log as _log, warn as _warn } from '../logger'
import type { IntegrationWorkspace } from '@ion/shared/types'

const TAG = 'bench.resolution.open'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * The open resolution merge in `benchPath`, or undefined when there is none.
 * A bench directory that does not exist yet has no merge. An unreadable probe
 * reports none and warns: the assembly gate still refuses on the real state.
 */
export async function readResolutionOpen(benchPath: string): Promise<IntegrationWorkspace['resolutionOpen']> {
  if (!existsSync(benchPath)) return undefined
  try {
    const probe = await probeOperationState(benchPath)
    if (probe.state !== 'merging') return undefined
    return { unmergedPaths: probe.conflictedPaths.length }
  } catch (err) {
    warn('could not read bench resolution state', { bench_path: benchPath, error: String(err) })
    return undefined
  }
}

/**
 * Abort the bench's open resolution merge when it is merging `pinnedSha`.
 *
 * Called when that member leaves the bench: the merge exists only to resolve
 * that member's contribution, so with the member gone there is nothing left to
 * resolve, and leaving it open would block every later assembly behind a merge
 * no member row points at. A merge of any other commit is left alone. Returns
 * true when a merge was aborted.
 */
export async function abortResolutionOf(benchPath: string, pinnedSha: string): Promise<boolean> {
  if (!pinnedSha || !(await readResolutionOpen(benchPath))) return false
  try {
    const mergeHead = (await runGit(benchPath, ['rev-parse', 'MERGE_HEAD'])).trim()
    if (mergeHead !== pinnedSha) {
      log('open resolution merge kept: it merges a different commit', {
        bench_path: benchPath, merge_head: mergeHead.slice(0, 7), removed_pin: pinnedSha.slice(0, 7),
      })
      return false
    }
    await runGit(benchPath, ['merge', '--abort'])
    log('open resolution merge aborted: its member left the bench', {
      bench_path: benchPath, merge_head: mergeHead.slice(0, 7),
    })
    return true
  } catch (err) {
    warn('could not abort the removed member\'s resolution merge', {
      bench_path: benchPath, removed_pin: pinnedSha.slice(0, 7), error: String(err),
    })
    return false
  }
}
