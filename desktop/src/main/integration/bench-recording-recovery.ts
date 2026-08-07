/**
 * Targeted, WORKING rerere-recording forget for the bench-verification
 * recovery flow.
 *
 * ── Why this exists alongside bench-rerere-purge.ts ─────────────────────────
 * `discardAllRerereRecordings` (bench-rerere-purge.ts) is the blunt verb: wipe
 * the whole `rr-cache`, no merge context required, because deleting the cache
 * directory needs none. This module is the surgical counterpart: forget the
 * recordings for SPECIFIC members, which does require merge context, because
 * `git rerere forget` can only identify a recording from a CURRENT conflict
 * (see bench-resolution-validation.ts). A caller with no merge open cannot use
 * `forgetRererePaths` directly and get anything real done — that gap was the
 * root defect this recovers from (bench-assemble.ts used to call it after
 * every merge had already committed and reported a discard that never
 * happened).
 *
 * ── The sequence, reused from bench-merge-continue.ts's restoreConflict ────
 * To forget member X's recording:
 *   1. Reset the bench to the source tip.
 *   2. Re-merge every enabled, non-empty-pin, non-landed member in order.
 *      A member BEFORE X that conflicts is expected to replay cleanly (it
 *      already did, in the assembly that produced the tree under
 *      investigation) — `tryReplayResolution` completes it exactly the way
 *      assembly did, so the bench state reaching X matches assembly's.
 *   3. When X's own merge attempt throws, MERGE_HEAD is now present with X's
 *      conflict active (replayed and staged, or genuinely unmerged — either
 *      way `git merge` exits non-zero on any conflict). That is real context:
 *      `currentRererePaths` + `forgetRererePaths` work here.
 *   4. After forgetting, prove it: the path must reappear in the unmerged
 *      index, because a forgotten recording is once again an unresolved
 *      conflict. Then abort — this flow does not resolve anything, it only
 *      removes the poisoned recording so the NEXT resolve-once attempt (or
 *      the next assembly's rerere replay, which will now genuinely conflict)
 *      starts from a clean slate.
 *
 * Never advances a pin, never leaves a merge open, never touches a member this
 * was not asked to forget. The caller reassembles afterward.
 */
import { runGit } from '../git-runner'
import { repositoryManager } from '../git/repositoryManager'
import { log as _log, warn as _warn } from '../logger'
import { resolveContribution, isLandedIntoSource } from './bench-contribution'
import { ensureRerereEnabled, tryReplayResolution } from './bench-assembly-rerere'
import { resetBenchToTree } from './bench-assemble-support'
import {
  currentRererePaths,
  forgetRererePaths,
  validateBenchResolution,
} from './bench-resolution-validation'
import type { IntegrationWorkspace } from '../../shared/types'

const TAG = 'bench.recording.recovery'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export interface ForgetForBranchesResult {
  ok: boolean
  /** Paths whose recording was actually verified forgotten, across every target branch. */
  forgottenPaths: string[]
  /** Branch names that were asked for but produced no conflict to forget within. */
  branchesWithNothingToForget: string[]
  error?: string
}

/** Reset the bench and replay every qualifying member up to (not including) the target. */
async function replayUpTo(
  ws: IntegrationWorkspace,
  targetBranch: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await resetBenchToTree(ws.benchPath, ws.benchBranch, ws.sourceBranch)
  } catch (err) {
    return { ok: false, error: `Could not reset the bench branch: ${String(err)}` }
  }

  for (const member of ws.members) {
    if (member.branchName === targetBranch) return { ok: true }
    if (!member.enabled || !member.pinnedSha) continue
    const contribution = await resolveContribution(ws.benchPath, member, ws.sourceBranch)
    if (contribution.empty) continue
    if (await isLandedIntoSource(ws.benchPath, member, ws.sourceBranch)) continue

    const message = `ion-bench: ${member.branchName}@${member.pinnedSha.slice(0, 7)}`
    try {
      await runGit(ws.benchPath, ['merge', '--no-ff', '-m', message, member.pinnedSha])
    } catch {
      const replay = await tryReplayResolution(ws.benchPath, message, member.branchName, member.pinnedSha)
      if (!replay.replayed) {
        return {
          ok: false,
          error: `Could not rebuild the bench state before ${targetBranch}: ${member.branchName} no longer merges cleanly or by replay.`,
        }
      }
    }
  }
  return {
    ok: false,
    error: `${targetBranch} is not an enrolled, enabled member with a contribution — nothing to rebuild toward.`,
  }
}

/**
 * Forget the recording for exactly one member's conflict, given the bench is
 * already reset and replayed up to (not including) that member.
 */
async function forgetOneBranch(
  ws: IntegrationWorkspace,
  branchName: string,
): Promise<{ ok: true; forgottenPaths: string[] } | { ok: false; nothingToForget: true } | { ok: false; error: string }> {
  const member = ws.members.find((m) => m.branchName === branchName)
  if (!member || !member.pinnedSha) {
    return { ok: false, error: `${branchName} is not an enrolled member with a pinned contribution.` }
  }

  const message = `ion-bench: ${member.branchName}@${member.pinnedSha.slice(0, 7)}`
  try {
    await runGit(ws.benchPath, ['merge', '--no-ff', '-m', message, member.pinnedSha])
    // No exception: this member's merge is clean against the rebuilt state.
    // Whatever produced the verification failure, it was not a poisoned
    // recording for THIS member right now — nothing to forget.
    log('branch merges cleanly on replay; nothing to forget', { branch: branchName, bench_path: ws.benchPath })
    return { ok: false, nothingToForget: true }
  } catch {
    const rerereCapture = await currentRererePaths(ws.benchPath)
    if (!rerereCapture.ok) {
      return { ok: false, error: `Could not capture conflict context for ${branchName}: ${rerereCapture.error}` }
    }
    const targetPaths = rerereCapture.paths
    const forgotten = await forgetRererePaths(ws.benchPath, targetPaths)
    if (!forgotten.ok) {
      const detail = 'error' in forgotten ? forgotten.error : 'no merge in progress to forget within'
      try { await runGit(ws.benchPath, ['merge', '--abort']) } catch { /* silent-ok: best-effort cleanup */ }
      return { ok: false, error: `Could not forget the recording for ${branchName}: ${detail}` }
    }

    // Proof: the forgotten path(s) must be unmerged again -- a forgotten
    // recording is, by definition, an unresolved conflict once more.
    const proof = await validateBenchResolution(ws.benchPath, 'forget-recordings-proof')
    const proven = !proof.ok && !proof.probeError
      && forgotten.forgottenPaths.every((path) => proof.unmergedPaths.includes(path))
    try {
      await runGit(ws.benchPath, ['merge', '--abort'])
    } catch (abortErr) {
      log('merge --abort not needed or failed after forget', { branch: branchName, error: String(abortErr) })
    }

    if (forgotten.forgottenPaths.length === 0) {
      return { ok: false, nothingToForget: true }
    }
    if (!proven) {
      warn('forgotten recording did not restore fresh unmerged paths as expected', {
        branch: branchName,
        bench_path: ws.benchPath,
        forgotten_paths: forgotten.forgottenPaths,
      })
    }
    log('forgot recording for branch', {
      branch: branchName,
      bench_path: ws.benchPath,
      forgotten_paths: forgotten.forgottenPaths,
      proven,
    })
    return { ok: true, forgottenPaths: forgotten.forgottenPaths }
  }
}

/**
 * Forget the recorded resolutions for a set of member branches, one at a time.
 *
 * Each target is processed against a freshly rebuilt bench state (reset +
 * replay up to that member), because forgetting member A's recording must not
 * disturb member B's — they are handled as fully independent recreate/forget/
 * abort cycles. Serialized on the repo mutation queue like every other bench
 * mutation; the bench is left in whatever state the LAST cycle's abort
 * produced, which is fine because the caller reassembles afterward.
 */
export async function forgetRecordingsForBranches(
  ws: IntegrationWorkspace,
  branchNames: string[],
): Promise<ForgetForBranchesResult> {
  const repo = repositoryManager.get(ws.repoPath)
  return repo.queue.enqueueMutation(async () => {
    await ensureRerereEnabled(ws.benchPath)
    const forgottenPaths: string[] = []
    const branchesWithNothingToForget: string[] = []

    for (const branchName of branchNames) {
      const rebuilt = await replayUpTo(ws, branchName)
      if (!rebuilt.ok) {
        warn('could not rebuild bench state to reach branch', { branch: branchName, error: rebuilt.error })
        return { ok: false, forgottenPaths, branchesWithNothingToForget, error: rebuilt.error }
      }

      const result = await forgetOneBranch(ws, branchName)
      if ('error' in result) {
        warn('forget failed for branch', { branch: branchName, error: result.error })
        return { ok: false, forgottenPaths, branchesWithNothingToForget, error: result.error }
      }
      if ('nothingToForget' in result) {
        branchesWithNothingToForget.push(branchName)
        continue
      }
      forgottenPaths.push(...result.forgottenPaths)
    }

    log('forget-recordings-for-branches complete', {
      bench_path: ws.benchPath,
      requested: branchNames.length,
      forgotten_paths: forgottenPaths.length,
      nothing_to_forget: branchesWithNothingToForget.length,
    })
    return { ok: true, forgottenPaths, branchesWithNothingToForget }
  })
}
