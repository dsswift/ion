/**
 * HostApi git/worktree/bench domain — see `host-api-engine.ts` for the
 * module-level explanation of what this file replaces and why.
 */
import { runGit } from '../git/git-runner'
import { probeOperationState } from '../git/operation-state'
import { partitionStatus } from '../git/diffs'
import {
  landAndRetireWorktree,
  syncWorktreeFromSource,
} from '../worktree/integrate'
import {
  closeWorktreeTitleSeed,
  lookupWorktreeRegistration,
  registerWorktree,
  setWorktreeStage,
  setWorktreeTitle,
} from '../worktree/inventory'
import { getWorktreeInventoryResult } from '../worktree/inventory-service'
import { appraiseWorktree } from '../worktree/safety'
import { startWorktreeProvisioning } from '../worktree/provision-start'
import { announceWorktreeTitle } from '../worktree/title-announce'
import { syncAllWorktrees } from '../worktree/sync-all'
import { discardWorktree } from '../worktree/relocate'
import {
  listWorkspaces,
  addMember,
  removeMember,
  setMemberOrder,
  updateMember,
  updateAllStale,
  assembleWorkspace,
  refreshStaleness,
  sourceBranchTip,
  prepareVerificationAnalysis,
  discardMemberRecordingsAndReassemble,
  predictPrunedBenches,
} from '../integration/bench-ops'
import { prepareConflictResolution } from '../integration/bench-resolve'
import { reconcileCompletedBenchResolution } from '../integration/bench-resolution-completion'
import {
  countRerereRecordings,
  discardAllRerereRecordings,
  forgetRerereRecordings,
} from '../integration/bench-rerere-purge'
import { isValidProjectPath } from '../ipc-validation'
import { existsSync } from 'fs'
import { randomBytes } from 'crypto'
import { basename, join } from 'path'
import { dataDir } from '../paths'
import { mkdirSync } from 'fs'
import { deriveEnvironmentDeveloperSurfaces } from '@ion/shared/developer-surfaces'
import { enterprisePolicyCache } from '../enterprise-policy-state'
import { warn as _warn } from '../logger'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('host-api-git', msg, fields)
}

export async function gitIsRepo(directory: string): Promise<{ isRepo: boolean }> {
  try {
    await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
    return { isRepo: true }
  } catch {
    return { isRepo: false }
  }
}

export async function gitChanges(directory: string) {
  try {
    await runGit(directory, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return { files: [], branch: '', isGitRepo: false, ahead: 0, behind: 0 }
  }
  let branch = ''
  try { branch = (await runGit(directory, ['branch', '--show-current'])).trim() } catch { /* no branch yet */ }
  let ahead = 0, behind = 0
  try {
    ahead = parseInt((await runGit(directory, ['rev-list', '--count', '@{upstream}..HEAD'])).trim(), 10) || 0
    behind = parseInt((await runGit(directory, ['rev-list', '--count', 'HEAD..@{upstream}'])).trim(), 10) || 0
  } catch { /* no upstream */ }
  try {
    const statusOutput = await runGit(directory, ['status', '--porcelain=v1', '-z', '-uall'])
    const result = partitionStatus(statusOutput).flat
    return { files: result, branch, isGitRepo: true, ahead, behind }
  } catch {
    return { files: [], branch, isGitRepo: true, ahead, behind }
  }
}

export async function gitOpState(directory: string) {
  try {
    const probe = await probeOperationState(directory)
    return { ok: true, state: probe.state ?? null, branch: probe.branch ?? null, onto: probe.onto ?? null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function gitRebaseAbort(directory: string) {
  try {
    const probe = await probeOperationState(directory)
    const verb = probe.state === 'merging' ? 'merge' : probe.state === 'cherry-picking' ? 'cherry-pick' : 'rebase'
    await runGit(directory, [verb, '--abort'])
    return { ok: true }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function gitRebaseContinue(directory: string) {
  try {
    const probe = await probeOperationState(directory)
    const verb = probe.state === 'merging' ? 'merge' : probe.state === 'cherry-picking' ? 'cherry-pick' : 'rebase'
    await runGit(directory, ['-c', 'core.editor=true', verb, '--continue'])
    return { ok: true }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function fsExists(path: string): Promise<{ exists: boolean }> {
  return Promise.resolve({ exists: existsSync(path) })
}

/** Whether this Environment's policy offers the worktrees developer surface. */
export async function worktreesOffered(): Promise<boolean> {
  return deriveEnvironmentDeveloperSurfaces(enterprisePolicyCache.policy).worktrees
}

export async function gitWorktreeAdd(repoPath: string, sourceBranch: string) {
  if (!(await worktreesOffered())) {
    warn('worktree add refused: worktrees are not offered on this server', { repo_path: repoPath, source_branch: sourceBranch })
    return { ok: false as const, error: 'worktrees are not available on this server' }
  }
  try {
    const slug = `${basename(repoPath)}-${randomBytes(4).toString('hex')}`
    const branchName = `wt/${slug}`
    const worktreeDir = join(dataDir(), 'worktrees')
    const worktreePath = join(worktreeDir, slug)
    mkdirSync(worktreeDir, { recursive: true })
    await runGit(repoPath, ['worktree', 'add', '-b', branchName, worktreePath, sourceBranch])
    let baseSha: string | undefined
    try { baseSha = (await runGit(worktreePath, ['rev-parse', 'HEAD'])).trim() } catch { /* best-effort */ }
    registerWorktree({ worktreePath, repoPath, branchName, sourceBranch, baseSha })
    void startWorktreeProvisioning(repoPath, worktreePath)
    return { ok: true, worktree: { worktreePath, branchName, sourceBranch, repoPath } }
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function gitWorktreeRegistration(worktreePath: string) {
  return Promise.resolve({ registration: lookupWorktreeRegistration(worktreePath) })
}

export async function gitWorktreeSetTitle(args: { worktreePath: string; repoPath?: string; title: string }) {
  const trimmed = args.title.trim()
  if (!trimmed) return { ok: false, error: 'A title cannot be empty.' }
  const registration = lookupWorktreeRegistration(args.worktreePath)
  const resolvedRepo = args.repoPath || registration?.repoPath || ''
  if (!setWorktreeTitle(args.worktreePath, trimmed, { repoPath: resolvedRepo })) {
    return { ok: false, error: 'Could not save the registry.' }
  }
  await announceWorktreeTitle(resolvedRepo, args.worktreePath, trimmed)
  return { ok: true, title: trimmed }
}

/**
 * Stamp a worktree with its conversation's name, without overriding a name it
 * already has.
 *
 * Only the first prompt sent in a worktree may name it. A worktree that has
 * already been prompted in is refused even when it has no name, so a later
 * conversation never names a worktree the first one left alone.
 *
 * `replaces` is the one exception: the name this same conversation stamped a
 * moment ago (its placeholder, taken from the prompt). The stored title is
 * swapped only while it still equals that string, so a generated title can
 * improve on its own placeholder but never on a name the operator typed or
 * another conversation stamped first.
 */
export async function gitWorktreeSeedTitle(worktreePath: string, title: string, replaces?: string) {
  const trimmed = title?.trim() ?? ''
  if (!worktreePath || !trimmed) return { ok: false, reason: 'empty-input' as const }
  if (!isValidProjectPath(worktreePath)) return { ok: false, reason: 'invalid-path' as const }
  const registration = lookupWorktreeRegistration(worktreePath)
  if (!registration) return { ok: false, reason: 'not-a-worktree' as const }
  if (registration.title && registration.title !== replaces?.trim()) {
    return { ok: false, reason: 'already-titled' as const, title: registration.title }
  }
  if (!registration.title && !registration.awaitingFirstPrompt) {
    return { ok: false, reason: 'not-first-prompt' as const }
  }
  if (!setWorktreeTitle(worktreePath, trimmed)) return { ok: false, reason: 'persist-failed' as const }
  await announceWorktreeTitle(registration.repoPath, worktreePath, trimmed)
  return { ok: true, title: trimmed }
}

/**
 * Record that a worktree's first prompt was sent without naming it, so no later
 * conversation names it either. `closed` is false when there was nothing to
 * close: not a registered worktree, or already prompted in.
 */
export function gitWorktreeCloseTitleSeed(worktreePath: string) {
  if (!worktreePath || !isValidProjectPath(worktreePath)) return Promise.resolve({ closed: false })
  return Promise.resolve({ closed: closeWorktreeTitleSeed(worktreePath) })
}

export function gitWorktreeSetStage(args: { worktreePath: string; repoPath?: string; stage: import('@ion/shared/types-git').WorkStage | null }) {
  const registration = lookupWorktreeRegistration(args.worktreePath)
  const resolvedRepo = args.repoPath || registration?.repoPath || ''
  const ok = setWorktreeStage(args.worktreePath, args.stage, { repoPath: resolvedRepo }, { kind: 'operator' })
  return Promise.resolve(ok ? { ok: true, stage: args.stage } : { ok: false, error: 'Could not save the registry.' })
}

export async function gitWorktreeInventory(repoPath: string) {
  // Through the service, never the raw crawl: multiple clients poll this on
  // an interval, and the service is what coalesces them into one bounded
  // crawl (see worktree/inventory-service.ts).
  const { entries: worktrees, repository } = await getWorktreeInventoryResult(repoPath)
  return { worktrees, repository }
}

export function gitWorktreeRetirePreview(worktreePath: string) {
  return Promise.resolve({ prunedBenchPaths: predictPrunedBenches(worktreePath) })
}

export function gitWorktreeReprovision(args: { repoPath: string; worktreePath: string }) {
  return startWorktreeProvisioning(args.repoPath, args.worktreePath).then((outcome) => ({ ok: outcome.state === 'ready', state: outcome.state, error: outcome.error }))
}

export async function gitWorktreeSync(worktreePath: string, sourceBranch: string) {
  try {
    await runGit(worktreePath, ['fetch', 'origin'])
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return syncWorktreeFromSource(worktreePath, sourceBranch)
}

export async function gitWorktreeSyncAll(repoPath: string) {
  return syncAllWorktrees(repoPath)
}

export function gitWorktreeLandAndRetire(args: { repoPath: string; worktreePath: string; worktreeBranch: string; branchName?: string; sourceBranch: string; noFf?: boolean; syncFirst?: boolean; requireFastForward?: boolean }) {
  const resolvedBranch = args.branchName ?? args.worktreeBranch
  return landAndRetireWorktree({ ...args, branchName: resolvedBranch })
}

export function gitWorktreeDiscard(args: { worktreePath: string; repoPath: string; branchName: string; sourceBranch: string }) {
  return discardWorktree(args)
}

export function gitWorktreeAppraise(worktreePath: string, sourceBranch: string) {
  return appraiseWorktree(worktreePath, sourceBranch)
}

export function applyWorktreeOverlap(_basis: unknown, _paths: string[]): Promise<{ ok: boolean; error?: string }> {
  // The Worktree Overlap visualizer is a desktop-only standalone window
  // (baseline.md §4): the repo/sourceBranch context it applies against is
  // tracked per-window by `worktree-overlap-window.ts`, which the server has
  // no equivalent of. `applyOverlapRecommendation` (worktree/overlap-apply.ts)
  // needs that `WorktreeOverlapContext` to run; nothing server-side can
  // resolve it today.
  return Promise.resolve({ ok: false, error: 'Worktree Overlap requires a desktop window session.' })
}

export async function benchList(repoPath: string) {
  const workspaces = listWorkspaces(repoPath)
  const tips: Record<string, string> = {}
  for (const ws of workspaces) tips[ws.sourceBranch] = await sourceBranchTip(repoPath, ws.sourceBranch)
  return { workspaces, tips }
}

export function benchAddMember(args: { repoPath: string; sourceBranch: string; worktreePath: string; branchName: string }) {
  return addMember(args.repoPath, args.sourceBranch, args.worktreePath, args.branchName)
}

export function benchRemoveMember(args: { repoPath: string; sourceBranch: string; worktreePath: string }) {
  return removeMember(args.repoPath, args.sourceBranch, args.worktreePath).then((workspace) => ({ workspace }))
}

export function benchSetOrder(args: { repoPath: string; sourceBranch: string; worktreePath: string; toIndex: number }) {
  return Promise.resolve({ workspace: setMemberOrder(args.repoPath, args.sourceBranch, args.worktreePath, args.toIndex) })
}

export function benchUpdateMember(args: { repoPath: string; sourceBranch: string; worktreePath: string }) {
  return updateMember(args.repoPath, args.sourceBranch, args.worktreePath)
}

export function benchUpdateAll(repoPath: string, sourceBranch: string) {
  return updateAllStale(repoPath, sourceBranch)
}

export function benchAssemble(repoPath: string, sourceBranch: string) {
  return assembleWorkspace(repoPath, sourceBranch)
}

export function benchResolveConflict(repoPath: string, sourceBranch: string) {
  return prepareConflictResolution(repoPath, sourceBranch)
}

export function benchRerereCount(directory: string) {
  return countRerereRecordings(directory)
}

export function benchRerereForget(directory: string, paths: string[]) {
  return forgetRerereRecordings(directory, paths)
}

export function benchRerereDiscardAll(directory: string) {
  return discardAllRerereRecordings(directory)
}

export function benchPrepareVerificationAnalysis(repoPath: string, sourceBranch: string) {
  return prepareVerificationAnalysis(repoPath, sourceBranch)
}

export function benchDiscardMemberRecordings(repoPath: string, sourceBranch: string, branchNames: string[]) {
  return discardMemberRecordingsAndReassemble(repoPath, sourceBranch, branchNames)
}

export function benchReconcileResolution(directory: string) {
  if (!isValidProjectPath(directory)) return Promise.resolve({ reconciled: false })
  return reconcileCompletedBenchResolution(directory).then((reconciled) => ({ reconciled }))
}

export function benchRefreshStaleness(repoPath: string, sourceBranch: string) {
  return refreshStaleness(repoPath, sourceBranch).then((workspace) => ({ workspace }))
}
