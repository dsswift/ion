import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'
import { loadWorkspaces, saveWorkspaces, findWorkspace } from './bench-store'
import { prepareVerificationDiagnostic } from './bench-verification-diagnostic'
import { forgetRecordingsForBranches } from './bench-recording-recovery'
import { assembleBench } from './bench-assemble'
import { isInsideBench } from './bench-guard'
import type { IntegrationWorkspace, BenchAssembleResult } from '../../shared/types'

const TAG = 'bench.ops.diagnostics'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}

function persist(ws: IntegrationWorkspace): void {
  const all = loadWorkspaces()
  const idx = all.findIndex((w) => w.repoPath === ws.repoPath && w.sourceBranch === ws.sourceBranch)
  if (idx >= 0) all[idx] = ws
  else all.push(ws)
  saveWorkspaces(all)
}

async function assembleAndPersist(ws: IntegrationWorkspace): Promise<BenchAssembleResult> {
  const result = await assembleBench(ws)
  if (result.ok && result.workspace) persist(result.workspace)
  return result
}

/**
 * Materialise the bench-verification analysis diagnostic and persist the
 * evidence, so the bar's "diagnosticTreeAt" state and the analysis
 * conversation agree with what is on disk.
 *
 * Refuses (does not persist anything) when the bench state has moved since
 * the failure being diagnosed — see prepareVerificationDiagnostic's own doc
 * for why that is the correct response rather than describing a stale tree.
 */
export async function prepareVerificationAnalysis(
  repoPath: string,
  sourceBranch: string,
): Promise<{ ok: boolean; benchPath?: string; error?: string }> {
  const ws = findWorkspace(loadWorkspaces(), repoPath, sourceBranch)
  if (!ws) return { ok: false, error: 'No integration workspace for this branch.' }
  const result = await prepareVerificationDiagnostic(repoPath, sourceBranch, ws)
  if (!result.ok || !result.workspace) return { ok: false, error: result.error }
  persist(result.workspace)
  return { ok: true, benchPath: ws.benchPath }
}

/**
 * General member-recording recovery: forget the recordings for named members,
 * then run a normal assembly and persist its outcome. Both the verification
 * dialog and a selected worktree row invoke this same precise recovery.
 */
export async function discardMemberRecordingsAndReassemble(
  repoPath: string,
  sourceBranch: string,
  branchNames: string[],
): Promise<BenchAssembleResult & { forgottenCount?: number; branchesWithNothingToForget?: string[] }> {
  const ws = findWorkspace(loadWorkspaces(), repoPath, sourceBranch)
  if (!ws) return { ok: false, error: 'No integration workspace for this branch.' }

  const forgotten = await forgetRecordingsForBranches(ws, branchNames)
  if (!forgotten.ok) {
    warn('discard-member-recordings: forget failed', {
      repo_path: repoPath,
      source_branch: sourceBranch,
      branches: branchNames,
      error: forgotten.error,
    })
    return { ok: false, error: forgotten.error }
  }
  log('discard-member-recordings: forgot recordings, reassembling', {
    repo_path: repoPath,
    source_branch: sourceBranch,
    branches: branchNames,
    forgotten_paths: forgotten.forgottenPaths.length,
    nothing_to_forget: forgotten.branchesWithNothingToForget,
  })
  const result = await assembleAndPersist(ws)
  return {
    ...result,
    forgottenCount: forgotten.forgottenPaths.length,
    branchesWithNothingToForget: forgotten.branchesWithNothingToForget,
  }
}

/** Resolve the bench worktree path for a repo/branch, if a workspace exists. */
export function benchPathFor(repoPath: string, sourceBranch: string): string | null {
  return findWorkspace(loadWorkspaces(), repoPath, sourceBranch)?.benchPath ?? null
}

/**
 * True when `path` is a bench directory for any known workspace.
 *
 * Delegates to `bench-guard.isInsideBench` so the main process has exactly ONE
 * definition of bench containment. This used to be `w.benchPath === path`,
 * which missed every SUBDIRECTORY of a bench — a caller asking about
 * `<bench>/desktop/src` was told it was not a bench.
 */
export function isBenchDirectory(path: string): boolean {
  return isInsideBench(path)
}

/** Current source-branch tip, for showing how far the bench base has drifted. */
export async function sourceBranchTip(repoPath: string, sourceBranch: string): Promise<string> {
  try {
    return (await runGit(repoPath, ['rev-parse', sourceBranch])).trim()
  } catch (err) {
    warn('could not read source branch tip', {
      repo_path: repoPath,
      source_branch: sourceBranch,
      error: String(err),
    })
    return ''
  }
}
