/**
 * Bench assembly — the deterministic function at the center of the design.
 *
 * ── The bench is a pure function, never an accumulator ──────────────────────
 * Bench contents are always recomputed from `(source tip, ordered member
 * list)`. Nothing is ever merged INTO an existing bench incrementally. Every
 * assembly throws the branch away and recreates it:
 *
 *     git switch -C ion/bench/<slug> <sourceBranch> --discard-changes
 *     git merge --no-ff -m "ion-bench: <label> (<branch>@<sha7>)" <pinnedSha>   # per member, in order
 *
 * Consequences that make this cheap to own:
 *   - The bench log is EXACTLY one merge commit per member, always. Updating a
 *     member replaces its single merge instead of stacking a new one.
 *   - Removing a member is subtraction from a set — there is no un-merge logic
 *     to write and no drift state to reconcile.
 *   - The result is a deterministic function of its inputs, so it can be
 *     asserted directly in tests.
 *
 * ── Pins, not tips ──────────────────────────────────────────────────────────
 * Each member is merged at its PINNED contribution, never a fresh read of its
 * current tip. That is what makes manual integration real: reassembling to pick
 * up member A cannot drag in member B's half-finished two-commit change. This
 * function NEVER advances a pin — pin advancement is the caller's explicit act
 * (see bench-ops.ts).
 *
 * A contribution is a RANGE (`pinnedBaseSha..pinnedSha`), not a tip. A member
 * whose range is empty has committed nothing of its own and is reported
 * `pending`: kept in the list, merged into nothing, never retired. That case is
 * indistinguishable from a landed member by any live git query, which is why the
 * range is recorded at pin time — see resolveContribution below.
 *
 * ── Never `git clean -x` ────────────────────────────────────────────────────
 * `switch -C ... --discard-changes` resets tracked files and LEAVES ignored
 * build output (node_modules, dist, Go caches) in place. That single decision
 * is what makes an assembly cost an incremental build instead of a cold one,
 * and it is the reason the feature is usable at all. Do not add a clean step.
 * The atomic-failure wipe below keeps the same property: it moves the branch to
 * an empty-TREE commit, which removes tracked files only.
 *
 * ── Assembly is atomic; conflicts fail the whole thing ──────────────────────
 * A member whose pinned contribution will not merge fails the ENTIRE assembly.
 * The failed merge is aborted, the conflict is captured (paths + which earlier
 * members' ranges touch them), and the bench branch is pointed at an
 * empty-tree commit — so a terminal or conversation opened in the bench finds
 * nothing to falsely test. The earlier behaviour (skip the member, keep the
 * rest) produced a silent partial bench: the operator tested a combination
 * that misrepresented what was enrolled, and nothing said so. Partial-on-
 * purpose remains available via the per-member exclude toggle.
 *
 * ── Resolve once: `git rerere` ──────────────────────────────────────────────
 * Before declaring a merge conflicted, `git rerere` is given the chance to
 * replay a previously recorded resolution. Recordings live in the MAIN repo's
 * `$GIT_COMMON_DIR/rr-cache` (linked worktrees share it), keyed by conflict
 * text — so wiping the bench never loses them, unrelated repo activity never
 * invalidates them, and a genuinely changed hunk stops matching and honestly
 * conflicts again. A merge completed this way is committed and reported
 * `merged` with `mergeResolution: 'replayed'`, never silently equated with a
 * clean merge. The recording is made by the resolve-once flow (bench-ops.ts
 * `resolveBenchConflict` + the ConflictsDialog), which leaves a real merge in
 * progress in the bench for the operator to resolve.
 */
import { existsSync, mkdirSync } from 'fs'
import { runGit } from '../git-runner'
import { repositoryManager } from '../git/repositoryManager'
import { log as _log, warn as _warn } from '../logger'
import { integrationRoot } from './bench-store'
import { benchMergeInProgress } from './bench-guard'
import { resolveContribution, isLandedIntoSource } from './bench-contribution'
import { ensureRerereEnabled, tryReplayResolution } from './bench-assembly-rerere'
import { parseWorktreeList } from '../worktree/integrate'
import type { IntegrationWorkspace, IntegrationMember, BenchAssembleResult } from '../../shared/types'

const TAG = 'bench.assemble'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Ensure the bench worktree exists and is registered with git.
 *
 * Self-healing: a bench directory deleted outside Ion is simply recreated on
 * the next assembly, because the durable state is the member set, not the tree.
 */
async function ensureBenchWorktree(ws: IntegrationWorkspace): Promise<void> {
  const listed = parseWorktreeList(await runGit(ws.repoPath, ['worktree', 'list', '--porcelain']))
  const registered = listed.some((w) => w.path === ws.benchPath)

  if (registered && existsSync(ws.benchPath)) {
    log('bench worktree present', { bench_path: ws.benchPath })
    return
  }

  if (registered && !existsSync(ws.benchPath)) {
    // Registered but the directory is gone (deleted outside Ion). Prune the
    // stale registration so the add below succeeds.
    log('bench worktree registered but missing on disk, pruning', { bench_path: ws.benchPath })
    await runGit(ws.repoPath, ['worktree', 'prune'])
  }

  mkdirSync(integrationRoot(), { recursive: true })
  log('creating bench worktree', { bench_path: ws.benchPath, bench_branch: ws.benchBranch, source_branch: ws.sourceBranch })
  await runGit(ws.repoPath, ['worktree', 'add', '-B', ws.benchBranch, ws.benchPath, ws.sourceBranch])
}

/**
 * Files left unmerged by a failed merge, and which earlier members touched them.
 *
 * ── Attribution asks about the RANGE, never the tip commit ──────────────────
 * The collision question is "does this member's CONTRIBUTION touch these
 * paths?", and a contribution is `pinnedBaseSha..pinnedSha` — the same range
 * the merge itself applies. This used to read `git show <pinnedSha>` (the tip
 * commit's file list), which is wrong for any member with more than one
 * commit: the live defect was a collider whose tip touched only a docs file
 * while an earlier commit in its range touched the conflicting path, so
 * attribution came back empty and the UI could name no counterpart. Same
 * mechanism and rationale as the engine's workspace-containment attribution.
 *
 * `pinnedBaseSha` can be empty on a legacy record; the bench's build base is
 * the honest fallback — every merged range is applied on top of it.
 */
async function describeConflict(
  benchPath: string,
  mergedSoFar: IntegrationMember[],
  buildBaseSha: string,
): Promise<{ paths: string[]; conflictsWith: string[] }> {
  let paths: string[] = []
  try {
    const raw = await runGit(benchPath, ['diff', '--name-only', '--diff-filter=U'])
    paths = raw.split('\n').map((p) => p.trim()).filter(Boolean)
  } catch (err) {
    warn('could not list conflicting paths', { bench_path: benchPath, error: String(err) })
  }

  // Attribute the collision: which already-merged members' ranges touch these
  // files? Per-member try/catch so one unreadable range cannot lose the whole
  // attribution — the conflict report still fires, just with fewer names.
  const conflictsWith: string[] = []
  for (const prior of mergedSoFar) {
    try {
      const base = prior.pinnedBaseSha || buildBaseSha
      const touched = await runGit(benchPath, ['diff', '--name-only', base, prior.pinnedSha])
      const touchedSet = new Set(touched.split('\n').map((p) => p.trim()).filter(Boolean))
      if (paths.some((p) => touchedSet.has(p))) conflictsWith.push(prior.branchName)
    } catch (err) {
      log('conflict attribution skipped for member', { branch: prior.branchName, error: String(err) })
    }
  }
  return { paths, conflictsWith }
}

/**
 * Wipe the bench to an empty tree after a failed assembly.
 *
 * The branch is pointed at a commit whose TREE is empty — created with the
 * well-known empty-tree object — and the working tree is reset to it. Tracked
 * files vanish; ignored build output (node_modules, caches) survives exactly
 * as it does across a normal assembly, so the next successful assembly still
 * builds incrementally. A terminal or conversation opened in the bench finds
 * nothing to falsely test, which is the whole point of atomicity: the bench
 * presents the enrolled combination or nothing.
 */
async function wipeBenchToEmpty(ws: IntegrationWorkspace, reason: string): Promise<void> {
  try {
    // The canonical empty tree exists in every repo; hash-object makes the
    // dependency explicit rather than hardcoding the well-known sha.
    const emptyTree = (await runGit(ws.benchPath, ['hash-object', '-t', 'tree', '/dev/null'])).trim()
    const commit = (await runGit(ws.benchPath, [
      'commit-tree', emptyTree, '-m', `ion-bench: assembly failed — ${reason}`,
    ])).trim()
    await runGit(ws.benchPath, ['switch', '-C', ws.benchBranch, commit, '--discard-changes'])
    log('bench wiped to empty tree after failed assembly', {
      bench_path: ws.benchPath,
      bench_branch: ws.benchBranch,
      reason,
    })
  } catch (err) {
    // The wipe failing leaves the bench at the last merged state, which is the
    // partial bench atomicity exists to prevent — loud, not fatal: the failure
    // record still marks the assembly failed, so no UI claims success.
    warn('could not wipe bench after failed assembly', { bench_path: ws.benchPath, error: String(err) })
  }
}


/**
 * Assemble the bench from the workspace's pinned member contributions.
 *
 * Serialized on the repo's mutation queue so an assembly never interleaves
 * with a land (or another assembly) in the same repository. Two different
 * projects assemble concurrently because they hold different queues.
 *
 * Returns an updated workspace record with per-member status and the new
 * `baseSha` / `lastBuiltAt` / `lastAssembly`. The caller persists it.
 */
export async function assembleBench(ws: IntegrationWorkspace): Promise<BenchAssembleResult> {
  const repo = repositoryManager.get(ws.repoPath)
  return repo.queue.enqueueMutation(() => assembleBenchUnqueued(ws))
}

/**
 * The assembly body without the queue wrapper. Exported for tests and for
 * callers already holding the repo mutation slot.
 */
export async function assembleBenchUnqueued(ws: IntegrationWorkspace): Promise<BenchAssembleResult> {
  const enabled = ws.members.filter((m) => m.enabled)
  log('assemble: starting', {
    repo_path: ws.repoPath,
    source_branch: ws.sourceBranch,
    bench_path: ws.benchPath,
    members_total: ws.members.length,
    members_enabled: enabled.length,
  })

  try {
    await ensureBenchWorktree(ws)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn('assemble: could not prepare bench worktree', { bench_path: ws.benchPath, error: msg })
    return { ok: false, error: `Could not prepare the bench worktree: ${msg}` }
  }

  // ── A resolve-once merge in progress refuses the assembly ────────────────
  // `prepareConflictResolution` deliberately leaves a merge open in the bench
  // so the operator (or the AI assist) can resolve it — the completed merge is
  // what records the rerere resolution. Assembling now would `switch -C` out
  // of that merge and destroy the resolution mid-flight; git itself refuses
  // with "cannot switch branch while merging", but that surfaced as a raw
  // machinery error. Refuse first, with the actionable reason. This is a
  // typed refusal (like dirty-bench), not a failure: finish or abort the
  // resolution, then assemble.
  if (benchMergeInProgress(ws.benchPath)) {
    log('assemble: refused, resolution merge in progress', { bench_path: ws.benchPath })
    return {
      ok: false,
      refusal: 'resolution-in-progress',
      error: 'A conflict resolution is in progress in the bench. Complete it (Continue) or abort it, then assemble.',
    }
  }

  // Recordings must be active BEFORE any merge runs, or a conflict neither
  // replays an existing resolution nor records a new one.
  await ensureRerereEnabled(ws.benchPath)

  // Reset the bench to the source tip. `--discard-changes` resets TRACKED
  // files only; ignored build output survives, which is what keeps the
  // following build incremental. Deliberately no `clean -x`.
  try {
    await runGit(ws.benchPath, ['switch', '-C', ws.benchBranch, ws.sourceBranch, '--discard-changes'])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn('assemble: could not reset bench branch', { bench_path: ws.benchPath, bench_branch: ws.benchBranch, error: msg })
    return { ok: false, error: `Could not reset the bench branch: ${msg}` }
  }

  const baseSha = (await runGit(ws.benchPath, ['rev-parse', 'HEAD'])).trim()
  log('assemble: bench reset to source tip', { bench_branch: ws.benchBranch, base_sha: baseSha.slice(0, 7) })

  const merged: IntegrationMember[] = []
  const updatedMembers: IntegrationMember[] = []
  const retired: IntegrationMember[] = []

  for (const member of ws.members) {
    // ── Empty contribution ────────────────────────────────────────────────
    // Checked BEFORE landed absorption, because the two are indistinguishable
    // by any live git query and the landed check would claim this member. A pin
    // that carries no commits has nothing to merge and nothing to absorb: the
    // member is simply enrolled ahead of its first commit, which is the natural
    // way to start work you intend to integrate.
    //
    // Reported as `pending` and KEPT. Retiring it was the defect: the member
    // vanished from the list on every assembly, so it could never be integrated.
    const contribution = await resolveContribution(ws.benchPath, member, ws.sourceBranch)
    if (contribution.empty) {
      log('assemble: member pending, nothing to merge', {
        branch: member.branchName,
        sha: member.pinnedSha.slice(0, 7),
        base: contribution.baseSha.slice(0, 7),
        source_branch: ws.sourceBranch,
        note: 'enrolled with no commits of its own; commit then Update to integrate',
      })
      updatedMembers.push({
        ...member,
        // Backfilled for a legacy record so the next assembly answers from the
        // record instead of re-deriving it.
        pinnedBaseSha: contribution.baseSha || member.pinnedBaseSha,
        // An empty pin is a PIN fact; there was nothing to merge, so the merge
        // axis records that no merge was attempted rather than claiming success.
        pin: 'empty',
        merge: 'skipped',
        conflictPaths: undefined,
        conflictsWith: undefined,
        mergeResolution: undefined,
      })
      continue
    }

    // ── Landed absorption ─────────────────────────────────────────────────
    // Checked BEFORE `enabled`, on purpose. Once a member's work is contained
    // in the source branch it arrives with the bench's base and there is no
    // merge to skip, so disabling the member cannot remove its content.
    // Reporting it as `excluded` would be a lie: the work is present.
    //
    // This is the land path: the operator lands a worktree into the FEATURE
    // branch (the workspace's source branch), typically after squashing a long
    // stream of commits into a tight set. From that point the work is part of
    // the feature branch permanently, so it is part of the bench without
    // option — sourced from the base rather than from the worktree. The bench
    // is functionally identical to what it was before the land.
    //
    // Absorption is purely a change to the BENCH's member list. It runs no git
    // command against the member worktree: the branch, its commits, and its
    // working tree are untouched and remain fully usable.
    if (await isLandedIntoSource(ws.benchPath, member, ws.sourceBranch)) {
      log('assemble: member landed into source, absorbed into base and retired', {
        branch: member.branchName,
        sha: member.pinnedSha.slice(0, 7),
        source_branch: ws.sourceBranch,
        was_enabled: member.enabled,
      })
      retired.push({
        ...member,
        pin: 'absorbed',
        // The content IS in the bench, sourced from the base rather than from a
        // merge of this member -- so `merged` would misattribute it.
        merge: 'skipped',
        conflictPaths: undefined,
        conflictsWith: undefined,
        mergeResolution: undefined,
      })
      continue
    }

    if (!member.enabled) {
      log('assemble: member excluded', { branch: member.branchName })
      // Only the MERGE axis moves. The pin keeps reporting how fresh this
      // member is, so an excluded member that has also moved on still says so --
      // the collapsed enum erased that and re-enabling merged a stale pin
      // silently.
      updatedMembers.push({ ...member, merge: 'skipped', conflictPaths: undefined, conflictsWith: undefined, mergeResolution: undefined })
      continue
    }
    if (!member.pinnedSha) {
      warn('assemble: member has no pinned contribution', { branch: member.branchName })
      updatedMembers.push({ ...member, pin: 'gone', merge: 'unbuilt', conflictPaths: undefined, conflictsWith: undefined, mergeResolution: undefined })
      continue
    }
    // A pinned commit whose object is gone (branch deleted and gc'd, worktree
    // removed) is `missing`, not a failure of the whole assembly.
    try {
      await runGit(ws.benchPath, ['cat-file', '-e', `${member.pinnedSha}^{commit}`])
    } catch {
      warn('assemble: member commit not found', { branch: member.branchName, sha: member.pinnedSha.slice(0, 7) })
      updatedMembers.push({ ...member, pin: 'gone', merge: 'unbuilt', conflictPaths: undefined, conflictsWith: undefined, mergeResolution: undefined })
      continue
    }

    // The branch names the contribution, and it is the identifier every git
    // verb uses. The member no longer carries a `label` copy of the worktree's
    // directory name -- that was one of the duplicated worktree fields the
    // sidecar removed, and the branch is the more useful of the two in a commit
    // message anyway.
    const message = `ion-bench: ${member.branchName}@${member.pinnedSha.slice(0, 7)}`
    try {
      await runGit(ws.benchPath, ['merge', '--no-ff', '-m', message, member.pinnedSha])
      log('assemble: member merged', { branch: member.branchName, sha: member.pinnedSha.slice(0, 7) })
      merged.push(member)
      updatedMembers.push({
        ...member,
        // Backfilled for a legacy record so the range is present from now on.
        pinnedBaseSha: contribution.baseSha || member.pinnedBaseSha,
        // The merge succeeded -- that is all this axis claims. Whether the
        // WORKTREE has since moved past the pin is a separate fact, preserved
        // here rather than overwritten, so a merged-but-behind member reports
        // both.
        merge: 'merged',
        pin: member.currentTreeHash && member.currentTreeHash !== member.pinnedTreeHash ? 'behind' : 'current',
        conflictPaths: undefined,
        conflictsWith: undefined,
        mergeResolution: undefined,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)

      // ── Replay a recorded resolution before declaring the conflict ───────
      // `git merge` already invoked rerere on the way down: a matching
      // recording is in the working tree and (autoUpdate) staged. If every
      // unmerged path was covered, the merge commits and the member reports
      // `merged` — flagged as replayed so the difference from a clean merge
      // stays observable in the record, the wire, and the logs.
      if (await tryReplayResolution(ws.benchPath, message, member.branchName, member.pinnedSha)) {
        merged.push(member)
        updatedMembers.push({
          ...member,
          pinnedBaseSha: contribution.baseSha || member.pinnedBaseSha,
          merge: 'merged',
          pin: member.currentTreeHash && member.currentTreeHash !== member.pinnedTreeHash ? 'behind' : 'current',
          conflictPaths: undefined,
          conflictsWith: undefined,
          mergeResolution: 'replayed',
        })
        continue
      }

      // ── Atomic failure ────────────────────────────────────────────────────
      // Capture the conflict detail while the merge is still in progress (the
      // unmerged index is the evidence), then abort and wipe. The whole
      // assembly fails: members merged before this point are NOT in the bench
      // after the wipe, so their merge axis says `unbuilt`, not `merged` —
      // claiming `merged` would describe a tree that no longer exists.
      const { paths, conflictsWith } = await describeConflict(ws.benchPath, merged, baseSha)
      warn('assemble: member conflicted, assembly failed', {
        branch: member.branchName,
        sha: member.pinnedSha.slice(0, 7),
        conflict_paths: paths.length,
        conflicts_with: conflictsWith.join(','),
        error: msg,
      })
      try {
        await runGit(ws.benchPath, ['merge', '--abort'])
      } catch (abortErr) {
        log('assemble: merge --abort not needed or failed', { branch: member.branchName, error: String(abortErr) })
      }

      const reason = `${member.branchName}@${member.pinnedSha.slice(0, 7)} conflicted`
      await wipeBenchToEmpty(ws, reason)

      const failureError = paths.length > 0
        ? `${member.branchName} conflicts on ${paths.length} file${paths.length === 1 ? '' : 's'}${conflictsWith.length > 0 ? ` with ${conflictsWith.join(', ')}` : ''}. The bench is empty until this is resolved.`
        : `${member.branchName} could not be merged. The bench is empty until this is resolved.`

      // Every member that is not THE conflicted one reports `unbuilt`: after
      // the wipe none of their content is in the bench, whatever happened
      // before the conflict. Pin facts are untouched — a conflicted member
      // that has also moved on keeps reporting `behind`, which is what tells
      // the operator whether Update is worth trying before resolving.
      const failedMembers = ws.members.map((m): IntegrationMember => (
        m.worktreePath === member.worktreePath
          ? { ...m, merge: 'conflicted', conflictPaths: paths, conflictsWith, mergeResolution: undefined }
          : { ...m, merge: m.enabled ? 'unbuilt' : 'skipped', conflictPaths: undefined, conflictsWith: undefined, mergeResolution: undefined }
      ))

      const failed: IntegrationWorkspace = {
        ...ws,
        members: failedMembers,
        baseSha,
        lastBuiltAt: Date.now(),
        lastAssembly: 'failed',
        lastAssemblyError: failureError,
      }
      log('assemble: failed atomically', {
        bench_path: ws.benchPath,
        conflicted_branch: member.branchName,
        conflict_paths: paths.length,
        conflicts_with: conflictsWith.join(','),
      })
      // ok:true — the ASSEMBLY ran and produced a definite, persisted outcome.
      // `ok:false` is reserved for the machinery failing (unpreparable
      // worktree, unresettable branch), where there is no outcome to record.
      return { ok: true, workspace: failed, retired }
    }
  }

  const result: IntegrationWorkspace = {
    ...ws,
    // Landed members are RETIRED from the list: a member represents pending
    // work to layer on top of the base, and landed work is no longer pending.
    // Its content lives in the source branch, which is where a pull request
    // into the trunk reads from, so nothing is lost by dropping the record.
    members: updatedMembers,
    baseSha,
    lastBuiltAt: Date.now(),
    lastAssembly: 'assembled',
    lastAssemblyError: undefined,
  }

  log('assemble: done', {
    bench_path: ws.benchPath,
    base_sha: baseSha.slice(0, 7),
    merged: merged.length,
    replayed: updatedMembers.filter((m) => m.mergeResolution === 'replayed').length,
    landed_retired: retired.length,
    empty_pin: updatedMembers.filter((m) => m.pin === 'empty').length,
    gone: updatedMembers.filter((m) => m.pin === 'gone').length,
    excluded: updatedMembers.filter((m) => !m.enabled).length,
    behind: updatedMembers.filter((m) => m.pin === 'behind').length,
  })
  return { ok: true, workspace: result, retired }
}
