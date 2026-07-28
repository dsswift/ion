/**
 * Bench operations — the workspace-level actions behind the Integration UI.
 *
 * The bench engine (rebuild, pinning, absorption) lives in bench-rebuild.ts.
 * This module owns the WORKSPACE lifecycle around it: finding or creating a
 * workspace, mutating the member set, advancing pins, and persisting the
 * result.
 *
 * ── Pins advance only here ──────────────────────────────────────────────────
 * `rebuildBench` deliberately never advances a pin. Every pin advance is an
 * explicit operator act and lives in this file: enrollment (`addMember`) and
 * Update (`updateMember` / `updateAllStale`). That separation is what makes
 * "rebuild" safe to press at any time — it re-merges exactly what was already
 * integrated and cannot pull in a half-finished change.
 */
import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'
import {
  loadWorkspaces, saveWorkspaces, findWorkspace, makeWorkspace, makeMember, workspacesForRepo,
} from './bench-store'
import { rebuildBench } from './bench-rebuild'
import { captureContribution, contributedTreeHash } from './bench-snapshot'
import { isInsideBench } from './bench-guard'
import type { IntegrationWorkspace, BenchRebuildResult } from '../../shared/types'

const TAG = 'bench.ops'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** Persist one workspace back into the stored list. */
function persist(ws: IntegrationWorkspace): void {
  const all = loadWorkspaces()
  const idx = all.findIndex((w) => w.repoPath === ws.repoPath && w.sourceBranch === ws.sourceBranch)
  if (idx >= 0) all[idx] = ws
  else all.push(ws)
  saveWorkspaces(all)
}

/** Every workspace for a repo (one per source branch integrated into). */
export function listWorkspaces(repoPath: string): IntegrationWorkspace[] {
  return workspacesForRepo(loadWorkspaces(), repoPath)
}

/**
 * Find or create the workspace for a `(repo, sourceBranch)` pair.
 *
 * Creating is cheap and non-destructive: it writes a record, not a worktree.
 * The bench directory is materialised lazily by the first rebuild.
 */
export function ensureWorkspace(repoPath: string, sourceBranch: string): IntegrationWorkspace {
  const all = loadWorkspaces()
  const existing = findWorkspace(all, repoPath, sourceBranch)
  if (existing) return existing
  const ws = makeWorkspace(repoPath, sourceBranch)
  all.push(ws)
  saveWorkspaces(all)
  log('workspace created', { repo_path: repoPath, source_branch: sourceBranch, bench_path: ws.benchPath })
  return ws
}

/**
 * Enroll a worktree, pinned at its current committed contribution.
 *
 * Refuses a duplicate rather than silently re-pinning: enrolling twice is an
 * operator mistake, and quietly advancing the pin would be an unrequested
 * integration of newer work.
 */
export async function addMember(
  repoPath: string,
  sourceBranch: string,
  worktreePath: string,
  branchName: string,
): Promise<{ ok: boolean; error?: string; workspace?: IntegrationWorkspace }> {
  const ws = ensureWorkspace(repoPath, sourceBranch)
  if (ws.members.some((m) => m.worktreePath === worktreePath)) {
    return { ok: false, error: 'This worktree is already a member of the bench.' }
  }
  try {
    const contribution = await captureContribution(worktreePath, sourceBranch)
    const member = makeMember({
      worktreePath,
      branchName,
      pinnedSha: contribution.sha,
      pinnedTreeHash: contribution.treeHash,
      pinnedBaseSha: contribution.baseSha,
    })
    const next = { ...ws, members: [...ws.members, member] }
    persist(next)
    log('member added', {
      branch: branchName,
      sha: contribution.sha.slice(0, 7),
      base: contribution.baseSha ? contribution.baseSha.slice(0, 7) : 'unknown',
      source_branch: sourceBranch,
      status: member.status,
    })
    return { ok: true, workspace: next }
  } catch (err) {
    warn('add member failed', { worktree_path: worktreePath, error: String(err) })
    return { ok: false, error: `Could not read that worktree: ${String(err)}` }
  }
}

/** Remove a member. The worktree itself is untouched. */
export function removeMember(
  repoPath: string,
  sourceBranch: string,
  worktreePath: string,
): IntegrationWorkspace | null {
  const ws = findWorkspace(loadWorkspaces(), repoPath, sourceBranch)
  if (!ws) return null
  const next = { ...ws, members: ws.members.filter((m) => m.worktreePath !== worktreePath) }
  persist(next)
  log('member removed', { worktree_path: worktreePath, source_branch: sourceBranch })
  return next
}

/**
 * Drop a retired worktree from EVERY bench that holds it, then prune any bench
 * left with no members.
 *
 * ── Why this is automatic while enrollment is not ────────────────────────────
 * Enrolling is a judgement ("integrate this work"), so it stays an explicit act.
 * Disenrolling a worktree that no longer exists is not a judgement — it is
 * bookkeeping catching up with reality. A member whose worktree is gone can
 * never be updated, rebuilt from, or landed; leaving it in the list produces a
 * permanent `missing` row the operator can only remove by hand.
 *
 * Called from the retire path, not from tab close: closing a conversation
 * leaves the worktree (and therefore its membership) intact by design.
 *
 * Searches every workspace rather than one `(repo, branch)` pair, because a
 * worktree's registry entry may already be gone by the time this runs.
 */
export function disenrollWorktree(worktreePath: string): { removedFrom: number; prunedBenches: string[] } {
  const all = loadWorkspaces()
  const prunedBenches: string[] = []
  let removedFrom = 0

  const kept: IntegrationWorkspace[] = []
  for (const ws of all) {
    if (!ws.members.some((m) => m.worktreePath === worktreePath)) {
      kept.push(ws)
      continue
    }
    removedFrom++
    const members = ws.members.filter((m) => m.worktreePath !== worktreePath)
    if (members.length === 0) {
      // An empty bench holds nothing unique -- its content is exactly the
      // feature branch -- so keeping the record would accumulate one dead bench
      // per feature branch ever integrated into. Prune it; the next enrollment
      // recreates it, and the git worktree is cleaned up by the caller.
      prunedBenches.push(ws.benchPath)
      log('bench pruned: last member disenrolled', {
        bench_path: ws.benchPath,
        source_branch: ws.sourceBranch,
      })
      continue
    }
    kept.push({ ...ws, members })
    log('member disenrolled', {
      worktree_path: worktreePath,
      source_branch: ws.sourceBranch,
      remaining_members: members.length,
    })
  }

  if (removedFrom > 0) saveWorkspaces(kept)
  return { removedFrom, prunedBenches }
}

/** Enable or exclude a member without removing it from the list. */
export function setMemberEnabled(
  repoPath: string,
  sourceBranch: string,
  worktreePath: string,
  enabled: boolean,
): IntegrationWorkspace | null {
  const ws = findWorkspace(loadWorkspaces(), repoPath, sourceBranch)
  if (!ws) return null
  const next = {
    ...ws,
    members: ws.members.map((m) => (m.worktreePath === worktreePath ? { ...m, enabled } : m)),
  }
  persist(next)
  log('member enabled changed', { worktree_path: worktreePath, enabled })
  return next
}

/**
 * Advance one member's pin to its current committed contribution, then rebuild.
 *
 * This is the Update verb: the single place a member's integrated content
 * changes. Other members keep their pins, which is what stops a rebuild for one
 * member from pulling in another's half-finished pair.
 */
export async function updateMember(
  repoPath: string,
  sourceBranch: string,
  worktreePath: string,
): Promise<BenchRebuildResult> {
  const ws = findWorkspace(loadWorkspaces(), repoPath, sourceBranch)
  if (!ws) return { ok: false, error: 'No integration workspace for this branch.' }
  const member = ws.members.find((m) => m.worktreePath === worktreePath)
  if (!member) return { ok: false, error: 'That worktree is not a member of this bench.' }

  let contribution
  try {
    contribution = await captureContribution(worktreePath, sourceBranch)
  } catch (err) {
    warn('update member failed to read contribution', { worktree_path: worktreePath, error: String(err) })
    return { ok: false, error: `Could not read that worktree: ${String(err)}` }
  }

  const next: IntegrationWorkspace = {
    ...ws,
    members: ws.members.map((m) => (m.worktreePath === worktreePath
      ? {
        ...m,
        pinnedSha: contribution.sha,
        pinnedTreeHash: contribution.treeHash,
        pinnedBaseSha: contribution.baseSha,
        currentTreeHash: contribution.treeHash,
      }
      : m)),
  }
  log('member pin advanced', {
    branch: member.branchName,
    sha: contribution.sha.slice(0, 7),
    base: contribution.baseSha ? contribution.baseSha.slice(0, 7) : 'unknown',
  })
  return rebuildAndPersist(next)
}

/** Advance every ENABLED STALE member's pin, then rebuild once. */
export async function updateAllStale(
  repoPath: string,
  sourceBranch: string,
): Promise<BenchRebuildResult> {
  const ws = findWorkspace(loadWorkspaces(), repoPath, sourceBranch)
  if (!ws) return { ok: false, error: 'No integration workspace for this branch.' }

  const members = [...ws.members]
  let advanced = 0
  for (let i = 0; i < members.length; i++) {
    const m = members[i]
    // Disabled members keep their pins: the operator excluded them
    // deliberately, and silently advancing would re-integrate on re-enable.
    if (!m.enabled) continue
    const current = await contributedTreeHash(m)
    if (!current || current === m.pinnedTreeHash) continue
    try {
      const contribution = await captureContribution(m.worktreePath, sourceBranch)
      members[i] = {
        ...m,
        pinnedSha: contribution.sha,
        pinnedTreeHash: contribution.treeHash,
        pinnedBaseSha: contribution.baseSha,
        currentTreeHash: contribution.treeHash,
      }
      advanced++
    } catch (err) {
      warn('update-all skipped a member', { branch: m.branchName, error: String(err) })
    }
  }
  log('update all stale', { source_branch: sourceBranch, advanced })
  return rebuildAndPersist({ ...ws, members })
}

/** Rebuild from existing pins. Changes no pin. */
export async function rebuildWorkspace(
  repoPath: string,
  sourceBranch: string,
): Promise<BenchRebuildResult> {
  const ws = findWorkspace(loadWorkspaces(), repoPath, sourceBranch)
  if (!ws) return { ok: false, error: 'No integration workspace for this branch.' }
  return rebuildAndPersist(ws)
}

/**
 * Re-evaluate staleness for every member. Read-only with respect to git and to
 * pins: it only records what each member's content is NOW so the UI can compare
 * it against what is integrated.
 */
export async function refreshStaleness(
  repoPath: string,
  sourceBranch: string,
): Promise<IntegrationWorkspace | null> {
  const ws = findWorkspace(loadWorkspaces(), repoPath, sourceBranch)
  if (!ws) return null

  const members = []
  for (const m of ws.members) {
    const current = await contributedTreeHash(m)
    if (current === null) {
      members.push({ ...m, status: 'missing' as const })
      continue
    }
    const stale = current !== m.pinnedTreeHash
    members.push({
      ...m,
      currentTreeHash: current,
      // Never overwrite a conflict verdict with a staleness verdict: a
      // conflicted member that also moved on is still conflicted, and hiding
      // that would send the operator to press Update expecting it to help.
      status: m.status === 'conflicted' ? m.status
        : !m.enabled ? ('excluded' as const)
          : stale ? ('stale' as const)
            // An unchanged member whose pin carries no commits is still pending.
            // Painting it `integrated` with a pinned sha would claim content the
            // bench does not hold — there is no merge behind that sha. It leaves
            // `pending` via the `stale` arm above the moment it commits.
            : m.status === 'pending' ? ('pending' as const)
              : ('integrated' as const),
    })
  }
  const next = { ...ws, members }
  persist(next)
  return next
}

/** Rebuild, persist the resulting statuses, and return the outcome. */
async function rebuildAndPersist(ws: IntegrationWorkspace): Promise<BenchRebuildResult> {
  const result = await rebuildBench(ws)
  if (result.ok && result.workspace) persist(result.workspace)
  return result
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
    warn('could not read source branch tip', { repo_path: repoPath, source_branch: sourceBranch, error: String(err) })
    return ''
  }
}
