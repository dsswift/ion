/**
 * Bench operations — the workspace-level actions behind the Integration UI.
 *
 * The bench engine (assembly, pinning, absorption) lives in bench-assemble.ts.
 * This module owns the WORKSPACE lifecycle around it: finding or creating a
 * workspace, mutating the member set, advancing pins, resolving a bench
 * conflict once, and persisting the result.
 *
 * ── Pins advance only here ──────────────────────────────────────────────────
 * `assembleBench` deliberately never advances a pin. Every pin advance is an
 * explicit operator act and lives in this file: enrollment (`addMember`) and
 * Update (`updateMember` / `updateAllStale`). That separation is what makes
 * "assemble" safe to press at any time — it re-merges exactly what was already
 * integrated and cannot pull in a half-finished change.
 */
import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'
import {
  loadWorkspaces, saveWorkspaces, findWorkspace, makeWorkspace, makeMember, workspacesForRepo,
} from './bench-store'
import { assembleBench } from './bench-assemble'
import { prepareVerificationDiagnostic } from './bench-verification-diagnostic'
import { forgetRecordingsForBranches } from './bench-recording-recovery'
import { dryRunCollision } from './bench-dry-run'
import { captureContribution, contributedTreeHash } from './bench-snapshot'
import { isInsideBench } from './bench-guard'
import { advanceWorktreeStageOnPinChange, lookupWorktreeLandedAt } from '../worktree/registry'
import type { IntegrationWorkspace, BenchAssembleResult, PinState } from '../../shared/types'

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
 * The bench directory is materialised lazily by the first assembly.
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
  if (lookupWorktreeLandedAt(worktreePath) != null) {
    warn('add member refused: worktree already landed', { worktree_path: worktreePath })
    return { ok: false, error: 'This worktree has already landed and cannot join an integration bench.' }
  }
  const ws = ensureWorkspace(repoPath, sourceBranch)
  if (ws.members.some((m) => m.worktreePath === worktreePath)) {
    return { ok: false, error: 'This worktree is already a member of the bench.' }
  }
  try {
    const contribution = await captureContribution(worktreePath, sourceBranch, branchName)
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
      pin: member.pin,
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
 * True when disenrolling `worktreePath` from `ws` would leave it with no
 * members — i.e. this bench is about to be pruned.
 *
 * ── Why this is its own exported predicate ──────────────────────────────────
 * Two callers need the same answer at two different times. `disenrollWorktree`
 * asks it while MUTATING (which benches am I removing?), and
 * `predictPrunedBenches` asks it while PREDICTING, before anything is touched,
 * so the retire pre-flight can refuse when an active conversation lives in a
 * bench this retire would delete. Two copies of the emptiness rule is how the
 * prediction and the mutation start disagreeing — and a prediction that misses
 * a bench is a directory deleted under a running agent.
 */
function wouldPruneBench(ws: IntegrationWorkspace, worktreePath: string): boolean {
  if (!ws.members.some((m) => m.worktreePath === worktreePath)) return false
  return ws.members.every((m) => m.worktreePath === worktreePath)
}

/**
 * The bench directories a retire of `worktreePath` WOULD remove, computed
 * without mutating anything.
 *
 * Read-only counterpart to `disenrollWorktree`, for callers that must know the
 * blast radius before committing to the retire. A bench worktree hosts real
 * conversations and a terminal, so a retire that prunes a bench deletes their
 * working directory too; the retire pre-flight uses this to include those tabs
 * in its "is anything still active?" question.
 *
 * Shares `wouldPruneBench` with the mutation, so the predicted set and the
 * removed set cannot drift.
 */
export function predictPrunedBenches(worktreePath: string): string[] {
  const paths = loadWorkspaces()
    .filter((ws) => wouldPruneBench(ws, worktreePath))
    .map((ws) => ws.benchPath)
  log('pruned-bench prediction', { worktree_path: worktreePath, pruned: paths.length })
  return paths
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
    if (wouldPruneBench(ws, worktreePath)) {
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
    const members = ws.members.filter((m) => m.worktreePath !== worktreePath)
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
    // Only the enrollment axis moves. The pin keeps saying how fresh the
    // contribution is, so re-enabling an excluded member that moved on still
    // reports `behind` — under the collapsed enum that fact was erased by the
    // exclusion and the operator got a silent stale merge.
    members: ws.members.map((m) => (m.worktreePath === worktreePath ? { ...m, enabled } : m)),
  }
  persist(next)
  log('member enabled changed', { worktree_path: worktreePath, enabled })
  return next
}

/**
 * Move a member to a new position in the merge order.
 *
 * Order IS array position — assembly iterates the array — so this is a splice
 * rather than a write to a stored index. An explicit `order` field would be a
 * second source of truth that could disagree with the array the merge actually
 * walks.
 *
 * The target index is clamped rather than rejected: a drag that overshoots the
 * end of the list means "last", which is what the operator saw when they let go.
 */
export function setMemberOrder(
  repoPath: string,
  sourceBranch: string,
  worktreePath: string,
  toIndex: number,
): IntegrationWorkspace | null {
  const ws = findWorkspace(loadWorkspaces(), repoPath, sourceBranch)
  if (!ws) return null
  const from = ws.members.findIndex((m) => m.worktreePath === worktreePath)
  if (from < 0) {
    warn('reorder skipped: not a member', { worktree_path: worktreePath, source_branch: sourceBranch })
    return null
  }
  const to = Math.max(0, Math.min(ws.members.length - 1, toIndex))
  if (to === from) return ws

  const members = [...ws.members]
  const [moved] = members.splice(from, 1)
  members.splice(to, 0, moved)
  const next = { ...ws, members }
  persist(next)
  log('member order changed', {
    worktree_path: worktreePath, source_branch: sourceBranch, from_index: from, to_index: to,
  })
  return next
}

/**
 * True when advancing to `contribution` would change what the pin holds.
 *
 * Gates the stage auto-transition: a `bug` stage belongs to the content that
 * was tested, so it survives an assembly or an Update that re-pins the
 * identical content (the bug is still in there), and moves to `test` the
 * moment the content actually changes. See `advanceWorktreeStageOnPinChange`.
 */
function pinChanged(
  member: IntegrationWorkspace['members'][number],
  contribution: { sha: string; treeHash: string; baseSha: string },
): boolean {
  return member.pinnedSha !== contribution.sha ||
    member.pinnedTreeHash !== contribution.treeHash ||
    member.pinnedBaseSha !== contribution.baseSha
}

/**
 * Advance one member's pin to its current committed contribution, then
 * assemble.
 *
 * This is the Update verb: the single place a member's integrated content
 * changes. Other members keep their pins, which is what stops an assembly for
 * one member from pulling in another's half-finished pair.
 */
export async function updateMember(
  repoPath: string,
  sourceBranch: string,
  worktreePath: string,
): Promise<BenchAssembleResult> {
  const ws = findWorkspace(loadWorkspaces(), repoPath, sourceBranch)
  if (!ws) return { ok: false, error: 'No integration workspace for this branch.' }
  const member = ws.members.find((m) => m.worktreePath === worktreePath)
  if (!member) return { ok: false, error: 'That worktree is not a member of this bench.' }

  let contribution
  try {
    contribution = await captureContribution(worktreePath, sourceBranch, member.branchName)
  } catch (err) {
    warn('update member failed to read contribution', { worktree_path: worktreePath, error: String(err) })
    return { ok: false, error: `Could not read that worktree: ${String(err)}` }
  }

  // Warn-early dry-run: predicted collision rides the result as a warning;
  // the update itself always proceeds.
  const warning = await dryRunCollision(ws, {
    worktreePath, branchName: member.branchName, sha: contribution.sha,
  })

  const advanced = pinChanged(member, contribution)
  const next: IntegrationWorkspace = {
    ...ws,
    members: ws.members.map((m) => (m.worktreePath === worktreePath
      ? {
        ...m,
        pinnedSha: contribution.sha,
        pinnedTreeHash: contribution.treeHash,
        pinnedBaseSha: contribution.baseSha,
        currentTreeHash: contribution.treeHash,
        // The pin now matches the branch by construction, whatever it was
        // before. An empty contribution stays empty.
        pin: (contribution.baseSha !== '' && contribution.baseSha === contribution.sha
          ? 'empty'
          : 'current') as PinState,
      }
      : m)),
  }
  // A `bug` stage describes the content that was tested, so new content moves
  // it to `test` (retest the fix); re-pinning identical content keeps it. The
  // rule lives in the registry beside the stage itself.
  if (advanced && !advanceWorktreeStageOnPinChange(worktreePath)) {
    warn('pin advanced but stage auto-advance persist failed', { worktree_path: worktreePath })
  }
  log('member pin advanced', {
    branch: member.branchName,
    sha: contribution.sha.slice(0, 7),
    base: contribution.baseSha ? contribution.baseSha.slice(0, 7) : 'unknown',
    pin_changed: advanced,
    collision_predicted: !!warning,
  })
  const result = await assembleAndPersist(next)
  return warning ? { ...result, warning } : result
}

/** Advance every ENABLED member whose pin is behind, then assemble once. */
export async function updateAllStale(
  repoPath: string,
  sourceBranch: string,
): Promise<BenchAssembleResult> {
  const ws = findWorkspace(loadWorkspaces(), repoPath, sourceBranch)
  if (!ws) return { ok: false, error: 'No integration workspace for this branch.' }

  const members = [...ws.members]
  let advanced = 0
  const warnings: string[] = []
  for (let i = 0; i < members.length; i++) {
    const m = members[i]
    // Disabled members keep their pins: the operator excluded them
    // deliberately, and silently advancing would re-integrate on re-enable.
    if (!m.enabled) continue
    const current = await contributedTreeHash(m)
    if (!current || current === m.pinnedTreeHash) continue
    try {
      const contribution = await captureContribution(m.worktreePath, sourceBranch, m.branchName)
      const moved = pinChanged(m, contribution)
      const warning = await dryRunCollision(ws, {
        worktreePath: m.worktreePath, branchName: m.branchName, sha: contribution.sha,
      })
      if (warning) warnings.push(warning)
      members[i] = {
        ...m,
        pinnedSha: contribution.sha,
        pinnedTreeHash: contribution.treeHash,
        pinnedBaseSha: contribution.baseSha,
        currentTreeHash: contribution.treeHash,
        pin: (contribution.baseSha !== '' && contribution.baseSha === contribution.sha
          ? 'empty'
          : 'current') as PinState,
      }
      // Same rule as updateMember: new content moves a `bug` stage to `test`;
      // identical content re-pinned keeps it.
      if (moved && !advanceWorktreeStageOnPinChange(m.worktreePath)) {
        warn('pin advanced but stage auto-advance persist failed', { worktree_path: m.worktreePath })
      }
      advanced++
    } catch (err) {
      warn('update-all skipped a member', { branch: m.branchName, error: String(err) })
    }
  }
  log('update all stale', { source_branch: sourceBranch, advanced, collisions_predicted: warnings.length })
  const result = await assembleAndPersist({ ...ws, members })
  return warnings.length > 0 ? { ...result, warning: warnings.join(' ') } : result
}

/** Assemble from existing pins. Changes no pin. */
export async function assembleWorkspace(
  repoPath: string,
  sourceBranch: string,
): Promise<BenchAssembleResult> {
  const ws = findWorkspace(loadWorkspaces(), repoPath, sourceBranch)
  if (!ws) return { ok: false, error: 'No integration workspace for this branch.' }
  return assembleAndPersist(ws)
}

/**
 * Re-evaluate staleness for every member. Read-only with respect to git and to
 * pins: it only records what each member's content is NOW so the UI can compare
 * it against what is integrated.
 *
 * ── Only the pin axis is written here ───────────────────────────────────────
 * This function used to compute a single collapsed `status`, which forced a
 * priority ladder: a conflict verdict had to be preserved by hand, exclusion
 * outranked staleness, and whichever fact lost the ordering was destroyed. The
 * concrete damage was an excluded member that had also moved on — it reported
 * only `excluded`, so re-enabling it merged a stale pin with no warning.
 *
 * Now staleness owns exactly one axis. `merge` belongs to assembly and `enabled`
 * belongs to the operator, so neither can be clobbered by an evaluation that
 * has nothing to say about them.
 */
export async function refreshStaleness(
  repoPath: string,
  sourceBranch: string,
): Promise<IntegrationWorkspace | null> {
  const ws = findWorkspace(loadWorkspaces(), repoPath, sourceBranch)
  if (!ws) return null

  const members = []
  let moved = 0
  for (const m of ws.members) {
    const current = await contributedTreeHash(m)
    if (current === null) {
      // The worktree or branch is gone. That is a PIN fact: what the bench holds
      // can no longer be compared to anything. The merge verdict from the last
      // build stays as it was — it is still the truth about that build.
      if (m.pin !== 'gone') moved++
      members.push({ ...m, pin: 'gone' as const })
      continue
    }
    // An empty pin stays empty until the member commits something of its own.
    // Painting it `current` would claim content the bench does not hold: there
    // is no merge behind that sha.
    const emptyPin = m.pinnedBaseSha !== '' && m.pinnedBaseSha === m.pinnedSha
    const pin: PinState = emptyPin && current === m.pinnedTreeHash
      ? 'empty'
      : current !== m.pinnedTreeHash ? 'behind' : 'current'
    if (pin !== m.pin || current !== m.currentTreeHash) moved++
    members.push({ ...m, currentTreeHash: current, pin })
  }
  const next = { ...ws, members }
  // Persist and log only when the evaluation actually changed something. This
  // runs on a poll while the worktree panel is open (every few seconds), and
  // an unconditional write turned that poll into an endless stream of
  // identical file writes and INFO lines for a bench nothing touched.
  if (moved > 0) {
    persist(next)
    log('staleness refreshed', {
      source_branch: sourceBranch,
      changed: moved,
      behind: members.filter((m) => m.pin === 'behind').length,
      gone: members.filter((m) => m.pin === 'gone').length,
      // Logged separately from `behind` precisely because the old model could not
      // report both at once.
      excluded: members.filter((m) => !m.enabled).length,
      conflicted: members.filter((m) => m.merge === 'conflicted').length,
    })
  }
  return next
}

/** Assemble, persist the resulting statuses, and return the outcome. */
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
      repo_path: repoPath, source_branch: sourceBranch, branches: branchNames, error: forgotten.error,
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
    warn('could not read source branch tip', { repo_path: repoPath, source_branch: sourceBranch, error: String(err) })
    return ''
  }
}
