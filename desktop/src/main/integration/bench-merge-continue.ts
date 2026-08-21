import { isAbsolute, resolve } from 'path'
import { readFile } from 'fs/promises'
import { runGit } from '../git-runner'
import { probeOperationState } from '../git/operation-state'
import { log as _log, warn as _warn } from '../logger'
import { runBenchVerify } from './bench-verify'
import {
  currentRererePaths,
  forgetRererePaths,
  validateBenchResolution,
} from './bench-resolution-validation'
import { loadWorkspaces } from './bench-store'
import { clearResolvedBenchConflict } from './bench-resolution-completion'
import { recordResolution } from './bench-resolution-journal'

const TAG = 'bench.merge.continue'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

type ContinueResult = { ok: true } | { ok: false; error: string }

interface RecoveryState {
  head: string
  mergeHead: string
  mergeMessage: string
  rererePaths: string[]
  /**
   * The paths that were unmerged when this merge was still open.
   *
   * Captured here because this is the only moment they are readable: once
   * `--continue` commits, the index has no unmerged entries and the resolved
   * paths are indistinguishable from any other file in the merge commit.
   */
  conflictedPaths: string[]
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
      // The same set: `currentRererePaths` returns rerere-status ∪ staged merge
      // paths, which IS the resolved conflict surface at this instant. Named
      // separately because the two are used for different purposes downstream
      // (recovery targets vs. what the journal records).
      conflictedPaths: rerere.paths,
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
    // `noContext` cannot fire here (the merge was just recreated above, so
    // MERGE_HEAD is present), but the union has no fallthrough default.
    const detail = 'error' in forgotten
      ? `invalid conflict recording for ${forgotten.path} could not be forgotten: ${forgotten.error}`
      : 'no merge in progress to forget within'
    return recoveryFailure(directory, state, detail)
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

  const verification = await runBenchVerify(directory, directory)
  if (verification.ran && !verification.ok) {
    warn('bench merge continue project verification failed', {
      directory,
      pre_head: captured.head,
      post_head: postHead,
      output_tail: verification.output.slice(-1200),
    })
    return restoreConflict(directory, captured)
  }

  log('bench merge continue completed with valid postconditions', {
    directory, pre_head: captured.head, post_head: postHead,
  })

  // Journal the resolution HERE and nowhere earlier.
  //
  // This is the one point where a bench resolution is proven good: the merge
  // committed, HEAD advanced, the delta passed `--check`, and project
  // verification passed. Everything before it is unproven, and every failure
  // above rolls the merge back through `restoreConflict` — so a resolution
  // recorded earlier could describe history that no longer exists.
  await journalResolution(directory, captured, postHead, verification.ran && verification.ok)
  clearResolvedBenchConflict(directory, captured.mergeHead)

  return { ok: true }
}

/**
 * Record the completed resolution in the bench journal.
 *
 * Resolves the workspace from the bench DIRECTORY, because that is all the
 * merge-continue path is given — and the directory is a stable identity
 * (`benchPathFor` is unique per repo+branch), so no id needs threading through
 * the IPC layer to get here.
 *
 * Attribution of the member being merged and its counterparts comes from the
 * merge itself: `MERGE_HEAD` is the pinned contribution git was merging, so the
 * member is whichever enrolled member carries that sha, and the counterparts are
 * the earlier members whose pinned ranges also touch the resolved paths.
 * That is the same range-based question `describeConflict` asks during assembly,
 * for the same reason: "who last touched this file" is confidently wrong exactly
 * when several members changed it.
 *
 * Never throws. The merge is already committed and verified by the time this
 * runs; failing it to report a missing hint would trade real work for context.
 */
async function journalResolution(
  directory: string,
  state: RecoveryState,
  resolvedSha: string,
  verified: boolean,
): Promise<void> {
  try {
    const ws = loadWorkspaces().find((w) => w.benchPath === directory)
    if (!ws) {
      log('resolution not journalled: directory is not a registered bench', { directory })
      return
    }
    if (state.conflictedPaths.length === 0) {
      log('resolution not journalled: no resolved paths captured', { directory })
      return
    }

    const members = ws.members.filter((m) => m.pinnedSha)
    const merged = members.find((m) => m.pinnedSha === state.mergeHead)
    const memberBranch = merged?.branchName ?? state.mergeHead.slice(0, 7)

    // One entry per resolved path: the journal is queried BY path, since the
    // next conflict is on a file rather than on a member.
    for (const path of state.conflictedPaths) {
      const collidedWith: string[] = []
      for (const other of members) {
        if (other.worktreePath === merged?.worktreePath) continue
        const base = other.pinnedBaseSha || ws.baseSha
        if (!base) continue
        try {
          const touched = await runGit(directory, ['diff', '--name-only', base, other.pinnedSha, '--', path])
          if (touched.trim()) collidedWith.push(other.branchName)
        } catch (err) {
          // Best-effort colour on an otherwise-correct entry.
          log('collision attribution skipped for member', {
            branch: other.branchName, path, error: String(err),
          })
        }
      }

      recordResolution({
        repoPath: ws.repoPath,
        sourceBranch: ws.sourceBranch,
        benchBranch: ws.benchBranch,
        path,
        memberBranch,
        collidedWith,
        baseSha: ws.baseSha,
        memberPinnedSha: state.mergeHead,
        resolvedSha,
        resolvedAt: Date.now(),
        verified,
        // The resolver records this separately (see the journal module); an
        // entry written here carries the mechanical facts and an empty
        // rationale rather than a fabricated one.
        rationale: '',
      })
    }
  } catch (err) {
    warn('could not journal bench resolution; merge stands', { directory, error: String(err) })
  }
}
