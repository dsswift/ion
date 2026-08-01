/**
 * Bench rebuild — the deterministic function at the center of the design.
 *
 * ── The bench is a pure function, never an accumulator ──────────────────────
 * Bench contents are always recomputed from `(source tip, ordered member
 * list)`. Nothing is ever merged INTO an existing bench incrementally. Every
 * rebuild throws the branch away and recreates it:
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
 * current tip. That is what makes manual integration real: rebuilding to pick
 * up member A cannot drag in member B's half-finished two-commit change. This
 * function NEVER advances a pin — pin advancement is the caller's explicit act
 * (see bench-update.ts).
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
 * is what makes a rebuild cost an incremental build instead of a cold one, and
 * it is the reason the feature is usable at all. Do not add a clean step.
 *
 * ── Conflicts are per-member, never fatal ───────────────────────────────────
 * A member whose pinned contribution will not merge is aborted, reported as
 * `conflicted` with its conflicting paths and the earlier members that touched
 * them, and SKIPPED. The rest of the bench still builds — a bad member never
 * costs the operator the working bench.
 */
import { existsSync, mkdirSync } from 'fs'
import { runGit } from '../git-runner'
import { repositoryManager } from '../git/repositoryManager'
import { log as _log, warn as _warn } from '../logger'
import { integrationRoot } from './bench-store'
import { parseWorktreeList } from '../worktree/integrate'
import type { IntegrationWorkspace, IntegrationMember, BenchRebuildResult } from '../../shared/types'

const TAG = 'bench.rebuild'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/**
 * Ensure the bench worktree exists and is registered with git.
 *
 * Self-healing: a bench directory deleted outside Ion is simply recreated on
 * the next rebuild, because the durable state is the member set, not the tree.
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

/** Files left unmerged by a failed merge, and which earlier members touched them. */
async function describeConflict(
  benchPath: string,
  mergedSoFar: IntegrationMember[],
): Promise<{ paths: string[]; conflictsWith: string[] }> {
  let paths: string[] = []
  try {
    const raw = await runGit(benchPath, ['diff', '--name-only', '--diff-filter=U'])
    paths = raw.split('\n').map((p) => p.trim()).filter(Boolean)
  } catch (err) {
    warn('could not list conflicting paths', { bench_path: benchPath, error: String(err) })
  }

  // Attribute the collision: which already-merged members touched these files?
  const conflictsWith: string[] = []
  for (const prior of mergedSoFar) {
    try {
      const touched = await runGit(benchPath, ['show', '--name-only', '--format=', prior.pinnedSha])
      const touchedSet = new Set(touched.split('\n').map((p) => p.trim()).filter(Boolean))
      if (paths.some((p) => touchedSet.has(p))) conflictsWith.push(prior.branchName)
    } catch (err) {
      log('conflict attribution skipped for member', { branch: prior.branchName, error: String(err) })
    }
  }
  return { paths, conflictsWith }
}

/**
 * Whether a member's pin carries any commits of its own, and the merge base that
 * proves it.
 *
 * ── Why this is asked from a RECORDED range, not a live query ────────────────
 * "This member has not committed anything yet" and "this member's work has
 * landed" are indistinguishable at rebuild time. In both cases `pinnedSha` is an
 * ancestor of the source branch and `sourceBranch..pinnedSha` is empty, so every
 * available git question answers the same way. The bench read the first case as
 * the second and silently retired the member — a worktree enrolled before its
 * first commit disappeared from the list on every rebuild.
 *
 * The separating fact is where the contribution STARTS, which is why the merge
 * base is captured when the pin is taken (`bench-snapshot.captureContribution`)
 * and stored as `pinnedBaseSha`. `pinnedBaseSha === pinnedSha` means empty, and
 * that survives the source branch moving underneath it.
 *
 * ── Legacy records ──────────────────────────────────────────────────────────
 * A record written before the range was tracked has `pinnedBaseSha === ''`, which
 * means UNKNOWN. It is resolved once, factually, against the member branch rather
 * than guessed: a branch with commits beyond the source branch gets its real
 * merge base backfilled and behaves exactly as before, and a branch with none is
 * empty. An unresolvable branch (deleted after a Land & retire) stays unknown and
 * falls through to the landed tiers, which is what correctly retires it.
 */
async function resolveContribution(
  benchPath: string,
  member: IntegrationMember,
  sourceBranch: string,
): Promise<{ empty: boolean; baseSha: string }> {
  if (member.pinnedBaseSha) {
    const empty = member.pinnedBaseSha === member.pinnedSha
    log('contribution range known', {
      branch: member.branchName,
      base: member.pinnedBaseSha.slice(0, 7),
      sha: member.pinnedSha.slice(0, 7),
      empty,
    })
    return { empty, baseSha: member.pinnedBaseSha }
  }

  // Unknown: a record from before the range was tracked. Resolve it from the
  // member branch, which is the only place the answer still exists.
  try {
    const count = (await runGit(benchPath, ['rev-list', '--count', `${sourceBranch}..${member.branchName}`])).trim()
    if (count === '0') {
      log('contribution range backfilled: empty', {
        branch: member.branchName,
        source_branch: sourceBranch,
        note: 'legacy record, member branch carries no commits beyond source',
      })
      return { empty: true, baseSha: member.pinnedSha }
    }
    const base = (await runGit(benchPath, ['merge-base', member.pinnedSha, sourceBranch])).trim()
    log('contribution range backfilled: carries commits', {
      branch: member.branchName,
      commits: count,
      base: base.slice(0, 7),
    })
    return { empty: false, baseSha: base }
  } catch (err) {
    // Branch gone (the normal Land & retire outcome) or an unreadable range.
    // Stay unknown so the landed tiers below decide, which is what retires a
    // landed-and-deleted member instead of parking it as pending forever.
    log('contribution range unresolved, deferring to landed detection', {
      branch: member.branchName,
      detail: String(err).slice(0, 120),
    })
    return { empty: false, baseSha: '' }
  }
}

/**
 * True when a member's work is already contained in the source branch — i.e.
 * it has landed and is now part of the bench's base.
 *
 * ── Why this is a CONTENT question, not a sha question ──────────────────────
 * The obvious check is `merge-base --is-ancestor <pinnedSha> <sourceBranch>`,
 * and it is correct only when the landed commits are literally the pinned ones.
 * The operator's real workflow breaks that assumption routinely:
 *
 *   - **Squash before landing.** Dozens of stream-of-consciousness commits get
 *     squashed into a tight set, then landed. The squashed commit is a NEW sha,
 *     so the pinned (pre-squash) sha is not an ancestor of the source branch —
 *     even though every line of its content is now there.
 *   - **Rebase before landing.** Same outcome: rewritten shas, identical content.
 *   - **Cherry-pick.** A different sha carrying the same patch.
 *
 * In all three cases a sha-based check reports "not landed" and the bench
 * re-merges work that is already in its base — at best a redundant merge
 * commit, at worst a conflict against the operator's own landed work.
 *
 * So the question asked is the content one: **does the member branch still
 * differ from the source branch?** `git diff --quiet <source> <branch>` exits
 * zero when the trees are identical, which means everything the member has to
 * contribute is present in the base. That is true for a fast-forward, a no-ff
 * merge, a squash, a rebase, and a cherry-pick alike.
 *
 * The sha check is kept as a fast path (it is cheap and covers the common
 * unsquashed case) but the content check is the authority.
 */
async function isLandedIntoSource(
  benchPath: string,
  member: IntegrationMember,
  sourceBranch: string,
): Promise<boolean> {
  // Tier 1 (fast path): the pinned commit itself is reachable from the source
  // branch. Covers the common land with no history rewriting.
  if (member.pinnedSha) {
    try {
      await runGit(benchPath, ['merge-base', '--is-ancestor', member.pinnedSha, sourceBranch])
      log('landed: pinned commit is an ancestor of source', {
        branch: member.branchName,
        sha: member.pinnedSha.slice(0, 7),
        source_branch: sourceBranch,
      })
      return true
    } catch {
      // Not an ancestor. Fall through to the content check — a squash or
      // rebase before landing makes this the NORMAL case, not an error.
    }
  }

  // Tier 2: does any commit in the source branch's history carry the member's
  // pinned TREE? This is what survives the branch being deleted — which is the
  // normal "Land & retire" outcome, where the worktree and its branch are both
  // gone by the time the bench rebuilds. Without this tier a landed-then-retired
  // member is misreported as `missing`, and its work looks lost even though it
  // is sitting in the feature branch.
  if (member.pinnedTreeHash) {
    try {
      const trees = await runGit(benchPath, ['rev-list', sourceBranch, '--format=%T', '--no-commit-header'])
      if (trees.split('\n').some((t) => t.trim() === member.pinnedTreeHash)) {
        log('landed: pinned tree found in source history', {
          branch: member.branchName,
          tree: member.pinnedTreeHash.slice(0, 7),
          source_branch: sourceBranch,
          note: 'survives branch deletion after Land & retire',
        })
        return true
      }
    } catch (err) {
      log('landed: tree-history scan unavailable', { branch: member.branchName, detail: String(err).slice(0, 120) })
    }
  }

  // Tier 3: does the member branch still carry content the base lacks? An
  // identical tree means the work landed, whatever the shas look like. Requires
  // the branch to still exist, so it runs last.
  try {
    await runGit(benchPath, ['diff', '--quiet', sourceBranch, member.branchName])
    log('landed: member branch content is identical to source', {
      branch: member.branchName,
      source_branch: sourceBranch,
      note: 'squash/rebase/cherry-pick land detected by content',
    })
    return true
  } catch (err) {
    // Non-zero exit from `diff --quiet` means "trees differ" — the member
    // still has work to contribute. A missing branch also lands here and is
    // correctly treated as "not absorbed"; the missing-commit check downstream
    // reports it as `missing`.
    log('landed: member still differs from source', {
      branch: member.branchName,
      source_branch: sourceBranch,
      detail: String(err).slice(0, 120),
    })
    return false
  }
}

/**
 * Rebuild the bench from the workspace's pinned member contributions.
 *
 * Serialized on the repo's mutation queue so a rebuild never interleaves with
 * a land (or another rebuild) in the same repository. Two different projects
 * rebuild concurrently because they hold different queues.
 *
 * Returns an updated workspace record with per-member status and the new
 * `baseSha` / `lastBuiltAt`. The caller persists it.
 */
export async function rebuildBench(ws: IntegrationWorkspace): Promise<BenchRebuildResult> {
  const repo = repositoryManager.get(ws.repoPath)
  return repo.queue.enqueueMutation(() => rebuildBenchUnqueued(ws))
}

/**
 * The rebuild body without the queue wrapper. Exported for tests and for
 * callers already holding the repo mutation slot.
 */
export async function rebuildBenchUnqueued(ws: IntegrationWorkspace): Promise<BenchRebuildResult> {
  const enabled = ws.members.filter((m) => m.enabled)
  log('rebuild: starting', {
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
    warn('rebuild: could not prepare bench worktree', { bench_path: ws.benchPath, error: msg })
    return { ok: false, error: `Could not prepare the bench worktree: ${msg}` }
  }

  // Reset the bench to the source tip. `--discard-changes` resets TRACKED
  // files only; ignored build output survives, which is what keeps the
  // following build incremental. Deliberately no `clean -x`.
  try {
    await runGit(ws.benchPath, ['switch', '-C', ws.benchBranch, ws.sourceBranch, '--discard-changes'])
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warn('rebuild: could not reset bench branch', { bench_path: ws.benchPath, bench_branch: ws.benchBranch, error: msg })
    return { ok: false, error: `Could not reset the bench branch: ${msg}` }
  }

  const baseSha = (await runGit(ws.benchPath, ['rev-parse', 'HEAD'])).trim()
  log('rebuild: bench reset to source tip', { bench_branch: ws.benchBranch, base_sha: baseSha.slice(0, 7) })

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
    // vanished from the list on every rebuild, so it could never be integrated.
    const contribution = await resolveContribution(ws.benchPath, member, ws.sourceBranch)
    if (contribution.empty) {
      log('rebuild: member pending, nothing to merge', {
        branch: member.branchName,
        sha: member.pinnedSha.slice(0, 7),
        base: contribution.baseSha.slice(0, 7),
        source_branch: ws.sourceBranch,
        note: 'enrolled with no commits of its own; commit then Update to integrate',
      })
      updatedMembers.push({
        ...member,
        // Backfilled for a legacy record so the next rebuild answers from the
        // record instead of re-deriving it.
        pinnedBaseSha: contribution.baseSha || member.pinnedBaseSha,
        status: 'pending',
        conflictPaths: undefined,
        conflictsWith: undefined,
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
      log('rebuild: member landed into source, absorbed into base and retired', {
        branch: member.branchName,
        sha: member.pinnedSha.slice(0, 7),
        source_branch: ws.sourceBranch,
        was_enabled: member.enabled,
      })
      retired.push({ ...member, status: 'landed', conflictPaths: undefined, conflictsWith: undefined })
      continue
    }

    if (!member.enabled) {
      log('rebuild: member excluded', { branch: member.branchName })
      updatedMembers.push({ ...member, status: 'excluded', conflictPaths: undefined, conflictsWith: undefined })
      continue
    }
    if (!member.pinnedSha) {
      warn('rebuild: member has no pinned contribution', { branch: member.branchName })
      updatedMembers.push({ ...member, status: 'missing', conflictPaths: undefined, conflictsWith: undefined })
      continue
    }
    // A pinned commit whose object is gone (branch deleted and gc'd, worktree
    // removed) is `missing`, not a failure of the whole rebuild.
    try {
      await runGit(ws.benchPath, ['cat-file', '-e', `${member.pinnedSha}^{commit}`])
    } catch {
      warn('rebuild: member commit not found', { branch: member.branchName, sha: member.pinnedSha.slice(0, 7) })
      updatedMembers.push({ ...member, status: 'missing', conflictPaths: undefined, conflictsWith: undefined })
      continue
    }

    const message = `ion-bench: ${member.label} (${member.branchName}@${member.pinnedSha.slice(0, 7)})`
    try {
      await runGit(ws.benchPath, ['merge', '--no-ff', '-m', message, member.pinnedSha])
      log('rebuild: member merged', { branch: member.branchName, sha: member.pinnedSha.slice(0, 7) })
      merged.push(member)
      updatedMembers.push({
        ...member,
        // Backfilled for a legacy record so the range is present from now on.
        pinnedBaseSha: contribution.baseSha || member.pinnedBaseSha,
        // Merged at the pin: by definition current with respect to what is
        // integrated. Staleness re-evaluates against the worktree separately.
        status: member.currentTreeHash && member.currentTreeHash !== member.pinnedTreeHash ? 'stale' : 'integrated',
        conflictPaths: undefined,
        conflictsWith: undefined,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const { paths, conflictsWith } = await describeConflict(ws.benchPath, merged)
      warn('rebuild: member conflicted, skipping', {
        branch: member.branchName,
        sha: member.pinnedSha.slice(0, 7),
        conflict_paths: paths.length,
        conflicts_with: conflictsWith.join(','),
        error: msg,
      })
      // Abort the failed merge so the bench returns to a clean state and the
      // remaining members can still be merged.
      try {
        await runGit(ws.benchPath, ['merge', '--abort'])
      } catch (abortErr) {
        log('rebuild: merge --abort not needed or failed', { branch: member.branchName, error: String(abortErr) })
      }
      updatedMembers.push({ ...member, status: 'conflicted', conflictPaths: paths, conflictsWith })
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
  }

  log('rebuild: done', {
    bench_path: ws.benchPath,
    base_sha: baseSha.slice(0, 7),
    merged: merged.length,
    landed_retired: retired.length,
    pending: updatedMembers.filter((m) => m.status === 'pending').length,
    conflicted: updatedMembers.filter((m) => m.status === 'conflicted').length,
    missing: updatedMembers.filter((m) => m.status === 'missing').length,
    excluded: updatedMembers.filter((m) => m.status === 'excluded').length,
  })
  return { ok: true, workspace: result, retired }
}
