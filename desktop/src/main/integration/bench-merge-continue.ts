import { isAbsolute, resolve } from 'path'
import { readFile } from 'fs/promises'
import { runGit } from '../git-runner'
import { probeOperationState } from '../git/operation-state'
import { log as _log, warn as _warn } from '../logger'
import {
  currentRererePaths,
  forgetRererePaths,
  validateBenchResolution,
} from './bench-resolution-validation'

const TAG = 'bench.merge.continue'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

type ContinueResult = { ok: true } | { ok: false; error: string }

interface RecoveryState {
  head: string
  mergeHead: string
  mergeMessage: string
  rererePaths: string[]
}

async function readGitStateFile(directory: string, name: string): Promise<string> {
  const rawPath = (await runGit(directory, ['rev-parse', '--git-path', name])).trim()
  const path = isAbsolute(rawPath) ? rawPath : resolve(directory, rawPath)
  return (await readFile(path, 'utf-8')).trim()
}

async function captureRecoveryState(directory: string): Promise<RecoveryState | ContinueResult> {
  const rerere = await currentRererePaths(directory)
  if (!rerere.ok) return { ok: false, error: `Could not capture conflict recovery paths: ${rerere.error}` }
  try {
    const [head, mergeHead, mergeMessage] = await Promise.all([
      runGit(directory, ['rev-parse', 'HEAD']),
      readGitStateFile(directory, 'MERGE_HEAD'),
      readGitStateFile(directory, 'MERGE_MSG'),
    ])
    return {
      head: head.trim(),
      mergeHead: mergeHead.trim(),
      mergeMessage,
      rererePaths: rerere.paths,
    }
  } catch (err) {
    return { ok: false, error: `Could not capture merge recovery state: ${String(err)}` }
  }
}

async function recoverableConflict(
  directory: string,
  expectedHead: string,
  expectedPaths: string[],
): Promise<boolean> {
  try {
    const [operation, head, validation] = await Promise.all([
      probeOperationState(directory),
      runGit(directory, ['rev-parse', 'HEAD']),
      validateBenchResolution(directory, 'postcommit-recovery-proof'),
    ])
    const actualPaths = validation.ok ? [] : validation.unmergedPaths
    return operation.state === 'merging'
      && head.trim() === expectedHead
      && expectedPaths.length > 0
      && expectedPaths.every((path) => actualPaths.includes(path))
  } catch (err) {
    warn('could not prove existing merge recoverable', { directory, error: String(err) })
    return false
  }
}

async function recoveryFailure(
  directory: string,
  state: RecoveryState,
  message: string,
): Promise<ContinueResult> {
  if (await recoverableConflict(directory, state.head, state.rererePaths)) {
    warn('postcommit recovery step failed but existing merge is recoverable', { directory, error: message })
    return { ok: false, error: `Merge validation failed. Existing conflict remains recoverable: ${message}` }
  }
  return { ok: false, error: `Merge validation failed and recoverable conflict could not be proved: ${message}` }
}

async function recreateMerge(directory: string, state: RecoveryState): Promise<string | undefined> {
  try {
    await runGit(directory, ['merge', '--no-ff', '-m', state.mergeMessage, state.mergeHead])
    return 'recreated merge completed without conflict'
  } catch {
    return undefined
  }
}

async function restoreConflict(directory: string, state: RecoveryState): Promise<ContinueResult> {
  try {
    await runGit(directory, ['reset', '--hard', state.head])
  } catch (err) {
    return recoveryFailure(directory, state, `HEAD could not be restored: ${String(err)}`)
  }

  // Recreate first. `git rerere forget` needs active conflict context; calling it
  // after reset but before merge silently loses ability to identify recording.
  const firstRecreateError = await recreateMerge(directory, state)
  if (firstRecreateError) return recoveryFailure(directory, state, firstRecreateError)

  const replayPaths = await currentRererePaths(directory)
  if (!replayPaths.ok) {
    return recoveryFailure(directory, state, `recreated replay paths could not be captured: ${replayPaths.error}`)
  }
  const forgotten = await forgetRererePaths(directory, replayPaths.paths)
  if (!forgotten.ok) {
    return recoveryFailure(
      directory,
      state,
      `invalid conflict recording for ${forgotten.path} could not be forgotten: ${forgotten.error}`,
    )
  }
  if (forgotten.forgottenPaths.length === 0) {
    return recoveryFailure(directory, state, 'no invalid rerere recording was forgotten')
  }

  try {
    await runGit(directory, ['reset', '--hard', state.head])
  } catch (err) {
    return recoveryFailure(directory, state, `second recovery reset failed: ${String(err)}`)
  }
  const secondRecreateError = await recreateMerge(directory, state)
  if (secondRecreateError) return recoveryFailure(directory, state, secondRecreateError)

  if (!await recoverableConflict(directory, state.head, forgotten.forgottenPaths)) {
    return recoveryFailure(directory, state, 'fresh merge did not restore exact forgotten paths as unmerged')
  }
  log('failed merge continuation restored as recoverable conflict', {
    directory,
    head: state.head,
    merge_head: state.mergeHead,
    rerere_paths: replayPaths.paths,
    forgotten_paths: forgotten.forgottenPaths,
  })
  return { ok: false, error: 'Completed merge failed validation. Original conflict was restored as recoverable for correction.' }
}

/** Run bench merge Continue as one queued preflight, mutation, and postcheck unit. */
export async function continueBenchMerge(directory: string): Promise<ContinueResult> {
  const validation = await validateBenchResolution(directory, 'ipc-merge-continue')
  if (!validation.ok) {
    const error = validation.probeError
      ? `Could not inspect unmerged paths: ${validation.probeError}`
      : validation.unmergedPaths.length > 0
        ? `Resolve and stage all merge conflicts before continuing. Unmerged: ${validation.unmergedPaths.join(', ')}.`
        : `Staged resolution failed git diff --cached --check: ${validation.stagedCheckError ?? 'invalid staged content'}`
    warn('bench merge continue preflight refused', {
      directory,
      unmerged_paths: validation.unmergedPaths,
      probe_error: validation.probeError,
      staged_check_error: validation.stagedCheckError,
    })
    return { ok: false, error }
  }

  const captured = await captureRecoveryState(directory)
  if ('ok' in captured) return captured
  log('bench merge continue preflight passed', { directory, pre_head: captured.head })

  try {
    await runGit(directory, ['-c', 'core.editor=true', 'merge', '--continue'])
  } catch (err) {
    warn('bench merge continue execution failed', { directory, error: String(err) })
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  let postState: Awaited<ReturnType<typeof probeOperationState>>
  let postHead: string
  try {
    postState = await probeOperationState(directory)
    postHead = (await runGit(directory, ['rev-parse', 'HEAD'])).trim()
  } catch (err) {
    warn('bench merge continue postcondition probe failed', { directory, error: String(err) })
    return restoreConflict(directory, captured)
  }
  if (postState.state) {
    warn('bench merge continue postcondition failed: operation remains open', {
      directory, operation_state: postState.state, pre_head: captured.head, post_head: postHead,
    })
    return restoreConflict(directory, captured)
  }
  if (postHead === captured.head) {
    warn('bench merge continue postcondition failed: head did not advance', {
      directory, pre_head: captured.head, post_head: postHead,
    })
    return restoreConflict(directory, captured)
  }

  try {
    await runGit(directory, ['diff', '--check', `${captured.head}..${postHead}`])
  } catch (err) {
    warn('bench merge continue postcondition failed: resulting delta invalid', {
      directory, pre_head: captured.head, post_head: postHead, error: String(err),
    })
    return restoreConflict(directory, captured)
  }

  log('bench merge continue completed with valid postconditions', {
    directory, pre_head: captured.head, post_head: postHead,
  })
  return { ok: true }
}
