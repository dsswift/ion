/**
 * Resolve-once — re-create the failed assembly merge and leave it in progress.
 *
 * Split from bench-ops.ts (file-size cap): this is the resolution half of the
 * atomic-assembly design. The ConflictsDialog operates on the merge this
 * prepares; committing it records the resolution (git rerere) that every
 * later assembly replays.
 */
import { runGit } from '../git-runner'
import { repositoryManager } from '../git/repositoryManager'
import { log as _log, warn as _warn } from '../logger'
import { loadWorkspaces, findWorkspace } from './bench-store'
import { resolveContribution } from './bench-contribution'

const TAG = 'bench.resolve'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Re-create the failed merge in the bench and LEAVE it in progress, so the
 * conflict can be resolved once — in a real merge, with real index stages —
 * and recorded by rerere for every future assembly to replay.
 *
 * ── Why the merge is re-created rather than kept from the failed assembly ───
 * A failed assembly aborts its merge and wipes the bench (atomicity: the bench
 * presents the enrolled combination or nothing). So at resolve time there is
 * no conflict on disk. This runs the same deterministic sequence the assembly
 * ran — reset to source tip, merge every enabled member in order — and stops
 * AT the conflicted merge instead of aborting it. The bench then has a real
 * `MERGE_HEAD`, real unmerged index entries, and the ConflictsDialog operates
 * on it exactly as it does on any conflicted checkout.
 *
 * When the operator completes the merge (Continue), git records the
 * resolution in the main repo's rr-cache (rerere.enabled was set by the
 * assembly), and the caller re-runs a full assembly — which now replays the
 * recording and succeeds. Abort just returns the bench to the wiped state via
 * the same reassembly.
 *
 * Members that merge cleanly on the way to the conflict are left merged in
 * the working state: they are the true context the conflicted member collides
 * against, and resolving against anything else would record the wrong
 * resolution.
 *
 * Serialized on the repo mutation queue like every other bench mutation.
 */
export async function prepareConflictResolution(
  repoPath: string,
  sourceBranch: string,
): Promise<{ ok: boolean; benchPath?: string; branchName?: string; error?: string }> {
  const ws = findWorkspace(loadWorkspaces(), repoPath, sourceBranch)
  if (!ws) return { ok: false, error: 'No integration workspace for this branch.' }

  const repo = repositoryManager.get(ws.repoPath)
  return repo.queue.enqueueMutation(async () => {
    log('resolve-once: preparing in-progress merge', {
      bench_path: ws.benchPath,
      source_branch: sourceBranch,
    })
    try {
      await runGit(ws.benchPath, ['switch', '-C', ws.benchBranch, ws.sourceBranch, '--discard-changes'])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warn('resolve-once: could not reset bench branch', { bench_path: ws.benchPath, error: msg })
      return { ok: false, error: `Could not reset the bench branch: ${msg}` }
    }

    for (const member of ws.members) {
      if (!member.enabled || !member.pinnedSha) continue
      // Skip members with nothing to merge — the SAME question the assembly
      // asks, from the same module, so the two walks cannot disagree about
      // which member conflicts.
      const contribution = await resolveContribution(ws.benchPath, member, ws.sourceBranch)
      if (contribution.empty) continue
      const message = `ion-bench: ${member.branchName}@${member.pinnedSha.slice(0, 7)}`
      try {
        await runGit(ws.benchPath, ['merge', '--no-ff', '-m', message, member.pinnedSha])
      } catch {
        // The conflicted member. Leave the merge IN PROGRESS — this state is
        // the whole product of this function. Rerere has already replayed any
        // matching recording; whatever is still unmerged is what the operator
        // resolves.
        const unmerged = (await runGit(ws.benchPath, ['diff', '--name-only', '--diff-filter=U'])).trim()
        if (!unmerged) {
          // A recording covered everything (recorded since the last assembly).
          // Nothing to resolve: commit and keep walking toward a clean bench.
          await runGit(ws.benchPath, ['commit', '--no-edit', '-m', message])
          log('resolve-once: conflict fully replayed while preparing, continuing', {
            branch: member.branchName,
          })
          continue
        }
        log('resolve-once: merge left in progress for resolution', {
          branch: member.branchName,
          bench_path: ws.benchPath,
          unmerged_paths: unmerged.split('\n').length,
        })
        return { ok: true, benchPath: ws.benchPath, branchName: member.branchName }
      }
    }

    // Nothing conflicted — the recordings (or a pin change) already cover it.
    // Tell the caller so it can simply reassemble.
    log('resolve-once: no conflict remains, bench merges cleanly', { bench_path: ws.benchPath })
    return { ok: true, benchPath: ws.benchPath }
  })
}
