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
import { benchMergeInProgress } from './bench-guard'
import { resetBenchToTree } from './bench-assemble-support'
import { resolveContribution, isLandedIntoSource } from './bench-contribution'
import {
  currentRererePaths,
  forgetRererePaths,
  validateBenchResolution,
} from './bench-resolution-validation'

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
    if (benchMergeInProgress(ws.benchPath)) {
      const branchName = await retainedMergeBranch(ws.benchPath, ws.members)
      log('resolve-once: existing resolution merge retained', {
        bench_path: ws.benchPath,
        source_branch: sourceBranch,
        branch: branchName ?? '',
      })
      return { ok: true, benchPath: ws.benchPath, branchName }
    }
    try {
      await resetBenchToTree(ws.benchPath, ws.benchBranch, ws.sourceBranch)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      warn('resolve-once: could not reset bench branch', { bench_path: ws.benchPath, error: msg })
      return { ok: false, error: `Could not reset the bench branch: ${msg}` }
    }

    for (const member of ws.members) {
      if (!member.enabled || !member.pinnedSha) continue
      // Landed members already arrive with the source base. Re-merging one can
      // create a false conflict after its worktree has been sealed.
      if (await isLandedIntoSource(ws.benchPath, member, ws.sourceBranch)) {
        log('resolve-once: skipping landed member already contained in source', {
          branch: member.branchName,
          bench_path: ws.benchPath,
          source_branch: ws.sourceBranch,
        })
        continue
      }
      // Skip members with nothing to merge — the SAME question the assembly
      // asks, from the same module, so the two walks cannot disagree about
      // which member conflicts.
      const contribution = await resolveContribution(ws.benchPath, member, ws.sourceBranch)
      if (contribution.empty) continue
      const message = `ion-bench: ${member.branchName}@${member.pinnedSha.slice(0, 7)}`
      try {
        await runGit(ws.benchPath, ['merge', '--no-ff', '-m', message, member.pinnedSha])
      } catch (err) {
        // Capture rerere's exact paths before any abort/reset destroys conflict
        // context. A fully replayed index is safe to commit only after Git's
        // staged-content check accepts it.
        const rerereCapture = await currentRererePaths(ws.benchPath)
        if (!rerereCapture.ok) {
          warn('resolve-once: could not capture rerere recovery context', {
            branch: member.branchName,
            bench_path: ws.benchPath,
            error: rerereCapture.error,
          })
          return { ok: false, error: `Could not capture conflict recovery state: ${rerereCapture.error}` }
        }
        const rererePaths = rerereCapture.paths
        const validation = await validateBenchResolution(ws.benchPath, 'prepare-conflict-resolution')
        if (validation.ok) {
          await runGit(ws.benchPath, ['commit', '--no-edit', '-m', message])
          log('resolve-once: valid conflict replay committed while preparing', {
            branch: member.branchName,
            bench_path: ws.benchPath,
            rerere_paths: rererePaths,
          })
          continue
        }

        if (validation.probeError) {
          warn('resolve-once: could not validate conflict index', {
            branch: member.branchName,
            bench_path: ws.benchPath,
            error: validation.probeError,
          })
          return { ok: false, error: `Could not inspect conflict state: ${validation.probeError}` }
        }

        if (validation.unmergedPaths.length === 0) {
          warn('resolve-once: invalid rerere replay rejected', {
            branch: member.branchName,
            bench_path: ws.benchPath,
            rerere_paths: rererePaths,
            staged_check_error: validation.stagedCheckError,
            merge_error: String(err),
          })
          const forgotten = await forgetRererePaths(ws.benchPath, rererePaths)
          if (!forgotten.ok) {
            // `noContext` cannot fire here (this runs mid-merge, on the way to
            // the failed merge attempt above), but the union has no default arm.
            return {
              ok: false,
              error: 'error' in forgotten
                ? `Could not forget invalid conflict recording for ${forgotten.path}: ${forgotten.error}`
                : 'Could not forget invalid conflict recording: no merge in progress to forget within.',
            }
          }
          if (forgotten.forgottenPaths.length === 0) {
            return { ok: false, error: 'Invalid replay was detected, but no rerere recording was forgotten.' }
          }
          // Forget while conflict context is active, then recreate same merge.
          // Fresh unmerged entries prove poison no longer replays.
          await runGit(ws.benchPath, ['merge', '--abort'])
          try {
            await runGit(ws.benchPath, ['merge', '--no-ff', '-m', message, member.pinnedSha])
          } catch (recreateErr) {
            const recreated = await validateBenchResolution(ws.benchPath, 'recreated-conflict')
            if (recreated.ok || recreated.probeError ||
                !forgotten.forgottenPaths.every((path) => recreated.unmergedPaths.includes(path))) {
              warn('resolve-once: recreated merge did not expose forgotten paths', {
                branch: member.branchName,
                bench_path: ws.benchPath,
                forgotten_paths: forgotten.forgottenPaths,
                unmerged_paths: recreated.unmergedPaths,
                probe_error: recreated.ok ? undefined : recreated.probeError,
                recreate_error: String(recreateErr),
              })
              return { ok: false, error: 'Invalid replay was forgotten, but fresh conflict state could not be verified.' }
            }
            log('resolve-once: merge recreated after invalid replay', {
              branch: member.branchName,
              bench_path: ws.benchPath,
              forgotten_paths: forgotten.forgottenPaths,
              unmerged_paths: recreated.unmergedPaths,
              recreate_error: String(recreateErr),
            })
          }
        }

        const unmerged = (await runGit(ws.benchPath, ['diff', '--name-only', '--diff-filter=U'])).trim()
        if (!unmerged) {
          warn('resolve-once: merge failed without a valid resolvable index', {
            branch: member.branchName,
            bench_path: ws.benchPath,
            error: String(err),
          })
          return { ok: false, error: 'The conflict could not be recreated with a valid resolution state.' }
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

/** Resolve retained merge's member from its exact MERGE_HEAD commit. */
async function retainedMergeBranch(
  benchPath: string,
  members: Array<{ branchName: string; pinnedSha: string }>,
): Promise<string | undefined> {
  try {
    const mergeHead = (await runGit(benchPath, ['rev-parse', 'MERGE_HEAD'])).trim()
    return members.find((member) => member.pinnedSha === mergeHead)?.branchName
  } catch (err) {
    warn('resolve-once: could not identify retained merge member', {
      bench_path: benchPath,
      error: String(err),
    })
    return undefined
  }
}
