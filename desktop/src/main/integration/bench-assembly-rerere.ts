import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'
import {
  currentRererePaths,
  forgetRererePaths,
  validateBenchResolution,
} from './bench-resolution-validation'

const TAG = 'bench.assemble.replay'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Enable shared rerere recording and automatic index updates for assembly. */
export async function ensureRerereEnabled(benchPath: string): Promise<void> {
  try {
    await runGit(benchPath, ['config', 'rerere.enabled', 'true'])
    await runGit(benchPath, ['config', 'rerere.autoUpdate', 'true'])
    log('rerere enabled for repository', { bench_path: benchPath })
  } catch (err) {
    warn('could not enable rerere', { bench_path: benchPath, error: String(err) })
  }
}

/** Validate, commit, or safely purge one rerere replay. */
export async function tryReplayResolution(
  benchPath: string,
  message: string,
  branchName: string,
  mergeTarget: string,
): Promise<boolean> {
  try {
    const rerereCapture = await currentRererePaths(benchPath)
    if (!rerereCapture.ok) {
      warn('rerere replay recovery stopped because paths could not be captured', {
        branch: branchName, bench_path: benchPath, error: rerereCapture.error,
      })
      return false
    }
    const rererePaths = rerereCapture.paths
    const validation = await validateBenchResolution(benchPath, 'assembly-rerere-replay')
    if (validation.ok) {
      await runGit(benchPath, ['commit', '--no-edit', '-m', message])
      log('merge completed from validated recorded resolution', {
        branch: branchName, bench_path: benchPath, rerere_paths: rererePaths,
      })
      return true
    }
    if (validation.unmergedPaths.length > 0) {
      log('rerere replay incomplete, conflict stands', {
        branch: branchName, unmerged_paths: validation.unmergedPaths,
      })
      return false
    }
    if (validation.probeError) {
      warn('rerere replay validation probe failed', {
        branch: branchName, bench_path: benchPath, probe_error: validation.probeError,
      })
      return false
    }

    warn('rerere replay failed staged validation, forgetting recording', {
      branch: branchName,
      bench_path: benchPath,
      rerere_paths: rererePaths,
      staged_check_error: validation.stagedCheckError,
    })
    const forgotten = await forgetRererePaths(benchPath, rererePaths)
    if (!forgotten.ok) {
      warn('rerere replay recovery stopped because recording could not be forgotten', {
        branch: branchName, bench_path: benchPath, path: forgotten.path, error: forgotten.error,
      })
      return false
    }
    if (forgotten.forgottenPaths.length === 0) {
      warn('rerere replay recovery found no recording to forget', {
        branch: branchName, bench_path: benchPath, rerere_paths: rererePaths,
      })
      return false
    }

    try {
      await runGit(benchPath, ['merge', '--abort'])
      await runGit(benchPath, ['merge', '--no-ff', '-m', message, mergeTarget])
      warn('rerere replay recovery unexpectedly merged cleanly after forget', {
        branch: branchName, bench_path: benchPath, forgotten_paths: forgotten.forgottenPaths,
      })
    } catch (recreateErr) {
      const recreated = await validateBenchResolution(benchPath, 'assembly-rerere-recreated-conflict')
      const exactPathsRestored = !recreated.ok && !recreated.probeError
        && forgotten.forgottenPaths.every((path) => recreated.unmergedPaths.includes(path))
      if (!exactPathsRestored) {
        warn('rerere replay recovery could not verify fresh unmerged paths', {
          branch: branchName,
          bench_path: benchPath,
          forgotten_paths: forgotten.forgottenPaths,
          unmerged_paths: recreated.unmergedPaths,
          recreate_error: String(recreateErr),
        })
      }
    }
    return false
  } catch (err) {
    warn('rerere replay commit failed, conflict stands', { branch: branchName, error: String(err) })
    return false
  }
}
