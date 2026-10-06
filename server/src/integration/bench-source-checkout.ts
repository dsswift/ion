/**
 * The folder on this machine that holds a source branch's integrated work:
 * its integration bench while one is built, otherwise the checkout that has
 * the branch itself.
 *
 * A bench is removed when its last member lands, and everything it held is
 * then on the source branch, so the two folders answer the same question at
 * different times. A caller that names a bench by `(repo, branch)` instead of
 * by its folder keeps finding the work after the bench is rebuilt or removed.
 */
import { existsSync } from 'fs'
import { resolve } from 'path'
import type { IntegrationWorkspace } from '@ion/shared/types'
import { findWorkspace, loadWorkspaces } from './bench-store'
import { findWorktreeForBranch } from '../worktree/integrate'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'bench.source-checkout'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** A bench named by its repository and the source branch it integrates into. */
export interface BenchRef {
  repoPath: string
  branch: string
}

export type BranchCheckout =
  | { ok: true; path: string; via: 'bench' | 'branch' }
  | { ok: false; error: string }

/** The folder that holds `branch`'s integrated work in `repoPath`, or why there is none. */
export async function checkoutForBranch(ref: BenchRef, workspaces: IntegrationWorkspace[] = loadWorkspaces()): Promise<BranchCheckout> {
  const { repoPath, branch } = ref
  const bench = findWorkspace(workspaces, repoPath, branch)
  if (bench?.lastAssembly === 'failed') {
    warn('bench failed its last assembly; nothing to build from', { repo_path: repoPath, branch, bench_path: bench.benchPath })
    return { ok: false, error: `The ${branch} bench failed to assemble, so it holds none of its worktrees' work. Resolve its conflict, then try again.` }
  }
  if (bench && existsSync(bench.benchPath)) {
    log('branch resolved to its bench', { repo_path: repoPath, branch, bench_path: bench.benchPath })
    return { ok: true, path: bench.benchPath, via: 'bench' }
  }
  let holder: Awaited<ReturnType<typeof findWorktreeForBranch>>
  try {
    holder = await findWorktreeForBranch(repoPath, branch)
  } catch (err) {
    return { ok: false, error: `The checkouts of ${repoPath} could not be listed: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (holder) {
    log('branch has no bench; resolved to the checkout that has it', { repo_path: repoPath, branch, bench_recorded: bench !== undefined, checkout: holder.path })
    return { ok: true, path: holder.path, via: 'branch' }
  }
  warn('branch has no bench and is checked out nowhere', { repo_path: repoPath, branch })
  return { ok: false, error: `No folder on this device holds ${branch}: ${repoPath} has no ${branch} bench, and ${branch} is not checked out. Check out ${branch}, or choose a folder.` }
}

/** The bench `folder` is, named by its repository and source branch; null for any other folder. */
export function benchOfFolder(folder: string, workspaces: IntegrationWorkspace[] = loadWorkspaces()): BenchRef | null {
  const wanted = resolve(folder)
  const bench = workspaces.find((w) => resolve(w.benchPath) === wanted)
  return bench ? { repoPath: bench.repoPath, branch: bench.sourceBranch } : null
}
