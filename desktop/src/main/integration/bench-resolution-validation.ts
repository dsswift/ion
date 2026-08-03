import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'bench.resolution.validation'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export type ResolutionValidation =
  | { ok: true; unmergedPaths: [] }
  | { ok: false; unmergedPaths: string[]; probeError?: string; stagedCheckError?: string }

export type RererePathResult =
  | { ok: true; paths: string[] }
  | { ok: false; error: string }

export type ForgetRerereResult =
  | { ok: true; forgottenPaths: string[] }
  | { ok: false; error: string; path: string; forgottenPaths: string[] }

function paths(raw: string): string[] {
  return raw.split('\n').map((path) => path.trim()).filter(Boolean)
}

function uniquePaths(...groups: string[][]): string[] {
  return [...new Set(groups.flat())]
}

/** Validate index state before any machinery commits an attempted resolution. */
export async function validateBenchResolution(
  benchPath: string,
  context: string,
): Promise<ResolutionValidation> {
  let unmergedPaths: string[]
  try {
    unmergedPaths = paths(await runGit(benchPath, ['diff', '--name-only', '--diff-filter=U']))
  } catch (err) {
    const probeError = err instanceof Error ? err.message : String(err)
    warn('resolution validation could not inspect unmerged index', {
      bench_path: benchPath,
      context,
      error: probeError,
    })
    return { ok: false, unmergedPaths: [], probeError }
  }

  if (unmergedPaths.length > 0) {
    log('resolution validation rejected unmerged index', {
      bench_path: benchPath,
      context,
      unmerged_count: unmergedPaths.length,
      unmerged_paths: unmergedPaths,
    })
    return { ok: false, unmergedPaths }
  }

  try {
    await runGit(benchPath, ['diff', '--cached', '--check'])
    log('resolution validation passed', {
      bench_path: benchPath,
      context,
      unmerged_count: 0,
      staged_check: 'passed',
    })
    return { ok: true, unmergedPaths: [] }
  } catch (err) {
    const stagedCheckError = err instanceof Error ? err.message : String(err)
    warn('resolution validation rejected staged content', {
      bench_path: benchPath,
      context,
      unmerged_count: 0,
      staged_check: 'failed',
      error: stagedCheckError,
    })
    return { ok: false, unmergedPaths: [], stagedCheckError }
  }
}

/**
 * Capture every path that can represent current rerere conflict context.
 *
 * `git rerere status` becomes empty after `rerere.autoUpdate` fully stages a
 * replay. While MERGE_HEAD exists, staged paths are therefore required
 * candidates. `git rerere forget` safely ignores staged paths without a rerere
 * record, while omitting them can leave poisoned full replays undiscoverable.
 */
export async function currentRererePaths(benchPath: string): Promise<RererePathResult> {
  try {
    const rererePaths = paths(await runGit(benchPath, ['rerere', 'status']))
    // Every recovery caller operates inside a merge. Requiring MERGE_HEAD
    // prevents an empty status result after context cleanup from looking safe.
    await runGit(benchPath, ['rev-parse', '--verify', 'MERGE_HEAD'])
    const stagedPaths = paths(await runGit(benchPath, ['diff', '--cached', '--name-only']))
    const capturedPaths = uniquePaths(rererePaths, stagedPaths)
    log('captured rerere recovery paths', {
      bench_path: benchPath,
      rerere_status_paths: rererePaths,
      staged_merge_paths: stagedPaths,
      rerere_paths: capturedPaths,
    })
    return { ok: true, paths: capturedPaths }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    warn('could not capture rerere paths', { bench_path: benchPath, error })
    return { ok: false, error }
  }
}

/** Forget only poisoned recordings identified in current conflict context. */
export async function forgetRererePaths(
  benchPath: string,
  rererePaths: string[],
): Promise<ForgetRerereResult> {
  const forgottenPaths: string[] = []
  for (const path of rererePaths) {
    try {
      await runGit(benchPath, ['rerere', 'forget', '--', path])
      const activePaths = paths(await runGit(benchPath, ['rerere', 'status']))
      const recordingForgotten = activePaths.includes(path)
      if (recordingForgotten) forgottenPaths.push(path)
      log('checked invalid rerere recording', {
        bench_path: benchPath,
        path,
        recording_forgotten: recordingForgotten,
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      warn('could not forget invalid rerere recording', {
        bench_path: benchPath,
        path,
        error,
        forgotten_paths: forgottenPaths,
      })
      return { ok: false, error, path, forgottenPaths }
    }
  }
  return { ok: true, forgottenPaths }
}
