/**
 * Worktree sync — rebasing a worktree onto the current tip of its source
 * branch, precisely, repeatably, and without duplicating history.
 *
 * Split from integrate.ts (which keeps the LAND verb) at the natural seam:
 * everything here serves "Sync from source", and integrate.ts re-exports this
 * module so callers keep one import path for the whole lifecycle API.
 *
 * The interesting mechanics live in the function headers below and in
 * patch-identity.ts: the stored-base precise rebase, why that path needs its
 * own already-upstream drop, the rerere auto-continue cascade, and the
 * base-repair self-healing that keeps repeated syncs replaying only the
 * worktree's own commits.
 */
import { randomBytes } from 'crypto'
import { unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runGit, gitExec } from '../git-runner'
import { ensureRerereEnabled } from '../git/rerere'
import { probeOperationState, unmergedPaths } from '../git/operation-state'
import { retryAfterClearingBlockingUntracked } from '../git/untracked-obstruction'
import { log as _log, warn as _warn } from '../logger'
import { lookupWorktreeBase, setWorktreeBase, lookupWorktreeLandedAt } from './inventory'
import { repairStaleBase } from './base-repair'
import { computeReplayPlan, type ReplayPlan } from './patch-identity'
import { invalidateWorktreeInventoryCache } from './inventory-cache'

// Deliberately keeps the historical 'worktree.land' tag: every sync log line
// since the verb shipped carries it, and jq/LogQL recipes filter on it. The
// sync verb was split out of the land module; the tag names the lifecycle
// family, not this file.
const TAG = 'worktree.land'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

/** True when the given working tree has uncommitted changes. */
export async function isDirty(directory: string): Promise<boolean> {
  const status = await runGit(directory, ['status', '--porcelain'])
  return status.trim().length > 0
}


/**
 * Upper bound on rebase auto-continue steps. Each conflicted-then-replayed
 * commit costs one iteration, so this bounds pathological loops (a hook that
 * re-conflicts forever) without ever being reachable by a real branch — a
 * worktree with 500 commits of its own is not a worktree.
 */
const MAX_REBASE_STEPS = 500

const EMPTY_REPLAY_PATTERNS = [
  /no changes/i,
  /nothing to commit/i,
  /did you forget to use.*git add/i,
]

function isEmptyReplayError(msg: string): boolean {
  return EMPTY_REPLAY_PATTERNS.some((p) => p.test(msg))
}

function isLockOrHookError(msg: string): boolean {
  return /\.lock\b/i.test(msg) || /hook/i.test(msg)
}

async function stagedDiffIsEmpty(worktreePath: string): Promise<boolean> {
  const diff = await runGit(worktreePath, ['diff', '--cached', '--raw', 'HEAD'])
  return diff.trim().length === 0
}

/**
 * Drive an in-progress rebase forward through every stop that `git rerere`
 * has already resolved, until the rebase finishes or a REAL conflict stands.
 *
 * When a rebase stops on a conflict with rerere enabled, git replays any
 * matching recording into the working tree and (`rerere.autoUpdate`) stages
 * it — but the rebase itself stays stopped, waiting for a human to say
 * `--continue`. This is the mechanical half of that human act: if nothing is
 * left unmerged, the stop is already resolved and continuing is the only
 * correct move. A stop with unmerged paths is a genuine conflict and is left
 * exactly as git left it.
 *
 * `core.editor=true` keeps `--continue` from opening an editor for the
 * replayed commit's message. A replay that makes a commit EMPTY (the source
 * branch already contains the change) makes `--continue` refuse; `--skip` is
 * git's own verb for that case, so it is the fallback rather than a failure.
 *
 * ── Untracked-obstruction self-heal ──────────────────────────────────────────
 * A later step's `pick` can be blocked by an untracked, non-ignored file
 * sitting at the exact path it wants to write — confirmed directly: a rebase
 * stopped genuinely mid-sequence on an earlier conflict, an untracked file
 * appears at a later step's path (debris from an earlier aborted operation,
 * a scratch file, anything not gitignored), and `--continue` then fails with
 * git's own "would be overwritten by rebase" refusal for that step — a
 * DIFFERENT failure shape than a real conflict (`ls-files --unmerged` is
 * empty; nothing here is a content collision to resolve). Retried once via
 * `retryAfterClearingBlockingUntracked`, which removes ONLY the exact paths
 * git's own error names, after re-verifying each is still untracked — never
 * a blanket clean, because this is the operator's durable worktree, not the
 * bench's disposable one (see `untracked-obstruction.ts`'s module doc for
 * why those two surfaces need different mechanisms).
 *
 * Exposed on its own (not only inside sync) so a worktree already stranded
 * mid-rebase — by a conflicted sync from before a resolution was recorded —
 * can be completed without re-running the sync.
 */
export async function completeRebaseIfReplayed(
  worktreePath: string,
): Promise<{ completed: boolean; conflictedPaths: string[]; error?: string }> {
  for (let step = 0; step < MAX_REBASE_STEPS; step++) {
    const probe = await probeOperationState(worktreePath)
    if (probe.state !== 'rebasing') {
      // The rebase is over — either it never was one, or the continues below
      // walked it to the end. Both are "nothing left to complete".
      if (step > 0) log('replay-complete: rebase finished', { worktree_path: worktreePath, steps: step })
      return { completed: true, conflictedPaths: [] }
    }
    if (probe.conflictedPaths.length > 0) {
      // A genuine conflict rerere has no recording for. Leave it standing.
      log('replay-complete: real conflict stands', {
        worktree_path: worktreePath,
        conflicted_paths: probe.conflictedPaths.length,
        steps: step,
      })
      return { completed: false, conflictedPaths: probe.conflictedPaths }
    }
    try {
      const { retried, removedPaths } = await retryAfterClearingBlockingUntracked(
        worktreePath,
        () => runGit(worktreePath, ['-c', 'core.editor=true', 'rebase', '--continue']),
      )
      if (retried) {
        log('replay-complete: continue succeeded after clearing blocking untracked paths', {
          worktree_path: worktreePath, removed_paths: removedPaths, steps: step,
        })
      }
    } catch (continueErr) {
      const errMsg = String(continueErr)

      if (isLockOrHookError(errMsg)) {
        warn('replay-complete: continue refused by lock or hook, not skipping', {
          worktree_path: worktreePath, error: errMsg, step,
        })
        return { completed: false, conflictedPaths: await unmergedPaths(worktreePath), error: errMsg }
      }

      if (!isEmptyReplayError(errMsg)) {
        warn('replay-complete: continue refused for unknown reason, not skipping', {
          worktree_path: worktreePath, error: errMsg, step,
        })
        return { completed: false, conflictedPaths: await unmergedPaths(worktreePath), error: errMsg }
      }

      const indexMatchesHead = await stagedDiffIsEmpty(worktreePath)
      if (!indexMatchesHead) {
        warn('replay-complete: empty-replay heuristic but staged diff non-empty, not skipping', {
          worktree_path: worktreePath, error: errMsg, step,
        })
        return { completed: false, conflictedPaths: await unmergedPaths(worktreePath), error: errMsg }
      }

      log('replay-complete: empty replay confirmed, skipping', {
        worktree_path: worktreePath, step,
      })
      try {
        const { retried, removedPaths } = await retryAfterClearingBlockingUntracked(
          worktreePath,
          () => runGit(worktreePath, ['rebase', '--skip']),
        )
        if (retried) {
          log('replay-complete: skip succeeded after clearing blocking untracked paths', {
            worktree_path: worktreePath, removed_paths: removedPaths, steps: step,
          })
        }
      } catch (skipErr) {
        const msg = skipErr instanceof Error ? skipErr.message : String(skipErr)
        warn('replay-complete: skip refused after confirmed empty replay', { worktree_path: worktreePath, error: msg })
        return { completed: false, conflictedPaths: await unmergedPaths(worktreePath), error: msg }
      }
    }
  }
  warn('replay-complete: step cap reached, giving up', { worktree_path: worktreePath, cap: MAX_REBASE_STEPS })
  return {
    completed: false,
    conflictedPaths: await unmergedPaths(worktreePath),
    error: `Rebase did not finish within ${MAX_REBASE_STEPS} auto-continue steps.`,
  }
}

/**
 * Log everything a replay plan discovered, before the rebase acts on it.
 *
 * Ordered deliberately: warnings first, then each individual drop, then the
 * totals. Reading `~/.ion/desktop.jsonl` forward therefore gives the anomalies,
 * the exact commits removed and what they matched upstream, and the summary — the
 * full reconstruction of what a sync did to a branch's history, without needing
 * the branch itself.
 */
function logReplayPlan(worktreePath: string, sourceBranch: string, plan: ReplayPlan): void {
  for (const w of plan.warnings) {
    // Every warning kind here means "something about this history is not what a
    // clean worktree looks like". None of them is routine, so all are WARN.
    warn('sync: replay plan warning', {
      worktree_path: worktreePath,
      source_branch: sourceBranch,
      kind: w.kind,
      shas: w.shas.join(','),
      detail: w.message,
      ...(w.error ? { error: w.error } : {}),
    })
  }
  for (const d of plan.dropped) {
    log('sync: dropping commit already present upstream', {
      worktree_path: worktreePath,
      source_branch: sourceBranch,
      sha: d.sha.slice(0, 9),
      subject: d.subject,
      upstream_sha: d.upstreamSha.slice(0, 9),
      patch_id: d.patchId,
    })
  }
  log('sync: replay plan resolved', {
    worktree_path: worktreePath,
    source_branch: sourceBranch,
    range_size: plan.rangeSize,
    picked: plan.pick.length,
    dropped: plan.dropped.length,
    warnings: plan.warnings.length,
    reliable: plan.reliable,
  })
}

/**
 * Run the precise rebase with an explicit todo list containing only the commits
 * the plan kept.
 *
 * `rebase -i` with a `GIT_SEQUENCE_EDITOR` that cats a pre-built todo is the same
 * mechanism the interactive-rebase IPC already uses (ipc/git-rebase.ts). It is
 * not a different kind of rebase from git's point of view: it writes the same
 * `rebase-merge` state directory `probeOperationState` reads, stops on conflict
 * identically, and is driven forward by the same
 * `completeRebaseIfReplayed` — so rerere recording and replay are untouched.
 *
 * `--empty=drop` matters: non-interactive rebase silently drops a commit whose
 * replay becomes empty ("patch contents already upstream"), but INTERACTIVE
 * rebase's default is to stop and ask. Without the flag this filtered path would
 * introduce a new stop for exactly the case the unfiltered path handles on its
 * own; with it, becomes-empty behavior matches the non-interactive path.
 *
 * `core.editor=true` prevents an editor opening for any commit message, matching
 * the auto-continue path. The todo file is removed on both outcomes.
 */
async function rebaseWithTodo(
  worktreePath: string,
  sourceBranch: string,
  storedBase: string,
  plan: ReplayPlan,
): Promise<void> {
  const todoFile = join(tmpdir(), `ion-sync-todo-${randomBytes(6).toString('hex')}`)
  // Dropped commits are written as comments rather than omitted silently: the
  // todo file is the artifact git logs about, and a reader comparing it to the
  // branch should see WHY a commit is absent.
  const body = [
    ...plan.pick.map((c) => `pick ${c.sha} ${c.subject}`),
    ...plan.dropped.map((c) => `# already upstream (${c.patchId}): ${c.sha} ${c.subject}`),
  ].join('\n') + '\n'
  writeFileSync(todoFile, body)
  try {
    await gitExec(
      'git',
      ['-c', 'core.editor=true', 'rebase', '-i', '--empty=drop', '--onto', sourceBranch, storedBase],
      {
        cwd: worktreePath,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, GIT_SEQUENCE_EDITOR: `cat ${JSON.stringify(todoFile)} >` },
      },
    )
  } finally {
    try { unlinkSync(todoFile) } catch { /* silent-ok: best-effort sync-todo temp-file cleanup */ }
  }
}

/**
 * Rebase a worktree onto the current tip of its source branch.
 *
 * Exposed on its own (the "Sync from source" verb) and reused as the optional
 * first step of a land. This is the resolution for BASE staleness: the feature
 * branch has moved on — because another worktree landed, a teammate pushed, or
 * the operator committed to it directly — and this worktree is developing
 * against stale code.
 *
 * ── Precise base: `--onto` from the stored base, not a merge-base guess ─────
 * When the registry knows the source-branch commit this worktree is based on
 * (`baseSha`, recorded at creation and advanced by every successful sync), the
 * rebase is `git rebase --onto <sourceBranch> <baseSha>` — replaying exactly
 * the worktree's own commits. The plain `git rebase <sourceBranch>` derives
 * the range from the merge base, which is wrong the moment the source branch
 * is itself rebased: the merge base falls behind the rewrite and the rebase
 * replays stale copies of upstream commits, manufacturing conflicts in content
 * the worktree never touched. The stored base is validated as an ancestor of
 * HEAD before use (the operator may have rebased outside Ion); anything else
 * falls back to the plain rebase, and a successful sync backfills the record.
 *
 * ── Why the precise path needs its OWN duplicate-drop (patch-identity.ts) ────
 * Git's preemptive already-upstream skip is keyed on `<upstream>`: on the plain
 * path that is the source branch and the skip works; on this path it is the
 * stored base, an ancestor of HEAD, so the comparison set is empty and the skip
 * can never fire. The replay-time becomes-empty drop still works here, but only
 * when the merge is clean — a commit whose content the source branch has since
 * moved BEYOND (every release-automation bump; any commit whose region upstream
 * edited again) CONFLICTS instead, and a conflict resolved the wrong way mints a
 * permanent inverse+forward duplicate pair that every later sync carries
 * forward verbatim. `computeReplayPlan` closes the gap: it computes the skip
 * explicitly with git's own `patch-id` against `merge-base(HEAD, source)..source`
 * (the set the plain path compares against) and the picks become an explicit
 * rebase todo, so the conflict never stands and the pair is never minted. When
 * nothing is droppable the todo path is skipped entirely and the plain `--onto`
 * runs unchanged. Full mechanism taxonomy: patch-identity.ts header.
 *
 * ── Self-healing the stored base (base-repair.ts) ───────────────────────────
 * `setWorktreeBase` is called ONLY from this function's own success path
 * below — but a rebase this function started can be finished by something
 * else entirely: an AI conflict-assist running raw `git rebase --continue` in
 * Bash, or the operator finishing it by hand. Either way HEAD ends up
 * genuinely built on a later point of the source branch, while the registry
 * still names the OLD cut point as the base. The old cut point stays an
 * ancestor of HEAD forever (the ancestor check above cannot tell reachable
 * from current), so the NEXT sync would recompute its replay range from that
 * stale point, re-include commits already upstream, and re-hit an already
 * resolved conflict with different surrounding context — missing rerere's
 * exact-text match and forcing a second resolution of the same file. Before
 * trusting the stored base, `repairStaleBase` recomputes the TRUE current fork
 * point (`git merge-base HEAD <source>`, an exact computation, not a guess)
 * and repairs the registry when the stored value has fallen behind it — so
 * staleness introduced by ANY completion path is caught here, not only the
 * one this function itself drives.
 *
 * ── Rerere: record, replay, auto-complete ───────────────────────────────────
 * Recording is enabled before the rebase (shared common-dir state — see
 * git/rerere.ts). When the rebase stops on a conflict rerere has a recording
 * for, the stop is auto-continued (see completeRebaseIfReplayed), so a
 * resolution made once — by hand or by the AI assist — clears the identical
 * conflict in every sibling worktree. A completion by replay is reported
 * (`replayed: true`), never silently equated with a clean rebase.
 *
 * A dirty worktree is REFUSED before git is asked to rebase. git would refuse
 * anyway ("cannot rebase: You have unstaged changes"), so the operator's work
 * is never at risk either way — but the raw git error is not actionable, and a
 * preflight lets the caller say what to do about it. The uncommitted work is
 * left exactly as it was.
 */
export async function syncWorktreeFromSource(
  worktreePath: string,
  sourceBranch: string,
): Promise<{
  ok: boolean
  error?: string
  hasConflicts?: boolean
  refusedDirty?: boolean
  replayed?: boolean
  /** Commits omitted because the source branch already carried their content. */
  dropped?: number
  /** Set when the sync succeeded but a side-effect (registry persist) failed. */
  warning?: string
}> {
  log('sync: starting', { worktree_path: worktreePath, source_branch: sourceBranch })

  // Landed worktrees are terminal -- sync is not meaningful.
  if (lookupWorktreeLandedAt(worktreePath) != null) {
    warn('sync: refused, worktree already landed', { worktree_path: worktreePath })
    return { ok: false, error: 'This worktree has already been landed. Sync is not available.' }
  }

  const existingOperation = await probeOperationState(worktreePath)
  if (existingOperation.state) {
    warn('sync: refused, git operation already in progress', {
      worktree_path: worktreePath,
      operation: existingOperation.state,
      conflicted_paths: existingOperation.conflictedPaths.length,
    })
    return {
      ok: false,
      hasConflicts: existingOperation.conflictedPaths.length > 0,
      error: `This worktree already has a ${existingOperation.state} in progress. Finish or abort it before syncing again.`,
    }
  }

  // Preflight: refuse a dirty tree with an actionable message rather than
  // letting git emit its own. Nothing is modified on this path.
  try {
    if (await isDirty(worktreePath)) {
      warn('sync: refused, worktree has uncommitted changes', { worktree_path: worktreePath })
      return {
        ok: false,
        refusedDirty: true,
        error:
          'This worktree has uncommitted changes, so it cannot be synced. ' +
          'Commit or stash them, then sync again. Your changes have not been touched.',
      }
    }
  } catch (err) {
    warn('sync: status probe failed', { worktree_path: worktreePath, error: String(err) })
    return { ok: false, error: `Could not read worktree status: ${String(err)}` }
  }

  // Recording must be active BEFORE the rebase, or a conflict neither replays
  // an existing resolution nor records a new one.
  await ensureRerereEnabled(worktreePath)

  // Capture the tip the worktree is about to be based on, BEFORE the rebase
  // moves anything. On success this becomes the stored base; failing to read
  // it only skips the base advance (the next sync falls back), never the sync.
  let sourceTip: string | null = null
  try {
    sourceTip = (await runGit(worktreePath, ['rev-parse', sourceBranch])).trim()
  } catch (err) {
    warn('sync: could not resolve source tip, base will not be advanced', {
      worktree_path: worktreePath, source_branch: sourceBranch, error: String(err),
    })
  }

  // Prefer the precise range when the stored base checks out. `--is-ancestor`
  // is the validity test: a base that is not an ancestor of HEAD means the
  // operator rebased outside Ion and the record is stale — using it would
  // replay the wrong range, so the plain rebase is the honest fallback.
  //
  // Before that check runs, self-heal against reality: a previous rebase this
  // worktree went through may have been COMPLETED by something other than this
  // function's own success path (an AI assist's raw `git rebase --continue`,
  // or the operator finishing it by hand), in which case `setWorktreeBase`
  // never ran and the registry still names the worktree's OLD cut point. That
  // old point stays an ancestor of HEAD forever on an append-only source
  // branch, so the ancestor check below cannot detect this on its own — see
  // base-repair.ts for why the true fork point has to be recomputed, not just
  // validated.
  let storedBase = lookupWorktreeBase(worktreePath)
  if (storedBase) {
    storedBase = await repairStaleBase(worktreePath, sourceBranch, storedBase)
  }
  let rebaseArgs = ['rebase', sourceBranch]
  let preciseBase = false
  let validBase: string | null = null
  if (storedBase) {
    try {
      await runGit(worktreePath, ['merge-base', '--is-ancestor', storedBase, 'HEAD'])
      rebaseArgs = ['rebase', '--onto', sourceBranch, storedBase]
      preciseBase = true
      validBase = storedBase
    } catch {
      log('sync: stored base is not an ancestor of HEAD, falling back to plain rebase', {
        worktree_path: worktreePath, stored_base: storedBase.slice(0, 7),
      })
    }
  } else {
    log('sync: no stored base, using plain rebase (will backfill on success)', {
      worktree_path: worktreePath,
    })
  }

  // On the precise path, compute the drop set git cannot compute for itself
  // here (see the header). The plain fallback needs none of this: `git rebase
  // <sourceBranch>` compares against the source branch already.
  //
  // `filtered` carries the base alongside the plan so the rebase driver never
  // has to re-derive (or assert) which base the plan was computed from.
  let filtered: { base: string; plan: ReplayPlan } | null = null
  if (validBase) {
    const plan = await computeReplayPlan({ directory: worktreePath, storedBase: validBase, sourceBranch })
    logReplayPlan(worktreePath, sourceBranch, plan)
    if (!plan.reliable) {
      // A degraded plan picks everything, which is exactly what the unfiltered
      // `--onto` does. Run that rather than a todo asserting a decision the
      // probe could not actually make.
      log('sync: replay plan unreliable, running the unfiltered precise rebase', {
        worktree_path: worktreePath, source_branch: sourceBranch,
      })
    } else if (plan.pick.length === 0 && plan.rangeSize > 0) {
      // Every commit is already upstream: this worktree's work has fully landed.
      // `rebase -i` with an empty todo aborts ("nothing to do"), which would
      // surface as an opaque failure, so move the branch to the source tip
      // directly — the exact result the rebase would have produced.
      log('sync: every commit already upstream, fast-forwarding to the source tip', {
        worktree_path: worktreePath, source_branch: sourceBranch, dropped: plan.dropped.length,
      })
      try {
        await runGit(worktreePath, ['reset', '--hard', sourceBranch])
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        warn('sync: fast-forward to source tip failed', {
          worktree_path: worktreePath, source_branch: sourceBranch, error: msg,
        })
        return { ok: false, error: msg }
      }
      let syncWarning: string | undefined
      if (sourceTip && !setWorktreeBase(worktreePath, sourceTip)) {
        syncWarning = 'Sync succeeded but the registry could not be updated.'
        warn('sync: base advanced but registry persist failed', { worktree_path: worktreePath })
      }
      invalidateWorktreeInventoryCache('worktree synced')
      log('sync: done', {
        worktree_path: worktreePath,
        source_branch: sourceBranch,
        precise_base: true,
        replayed: false,
        dropped: plan.dropped.length,
        base_advanced: !!sourceTip,
      })
      return { ok: true, dropped: plan.dropped.length, warning: syncWarning }
    } else if (plan.dropped.length > 0) {
      filtered = { base: validBase, plan }
    }
  }

  const droppedCount = filtered?.plan.dropped.length ?? 0
  let replayed = false
  try {
    if (filtered) await rebaseWithTodo(worktreePath, sourceBranch, filtered.base, filtered.plan)
    else await runGit(worktreePath, rebaseArgs)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // The rebase stopped. If rerere already replayed a recorded resolution
    // for this stop, drive it forward — that cascade is what makes the Nth
    // worktree's sync free after the first one's conflict is resolved.
    const completion = await completeRebaseIfReplayed(worktreePath)
    if (!completion.completed) {
      const hasConflicts = completion.conflictedPaths.length > 0
      warn('sync: failed', {
        worktree_path: worktreePath,
        source_branch: sourceBranch,
        precise_base: preciseBase,
        dropped: droppedCount,
        has_conflicts: hasConflicts,
        conflicted_paths: completion.conflictedPaths.length,
        error: completion.error ?? msg,
      })
      if (hasConflicts) {
        return {
          ok: false,
          hasConflicts: true,
          error:
            `Syncing from ${sourceBranch} hit a conflict. Resolve it in ${worktreePath} ` +
            '(git rebase --continue), or run git rebase --abort to return to where you were.',
        }
      }
      return { ok: false, error: completion.error ?? msg }
    }
    replayed = true
    log('sync: completed by replaying recorded resolutions', {
      worktree_path: worktreePath, source_branch: sourceBranch,
    })
  }

  // Advance the stored base: the worktree is now based on the tip captured
  // above. Written only on success, from the sync path only — see
  // setWorktreeBase for why no other code writes this.
  let rebaseWarning: string | undefined
  if (sourceTip && !setWorktreeBase(worktreePath, sourceTip)) {
    rebaseWarning = 'Sync succeeded but the registry could not be updated.'
    warn('sync: base advanced but registry persist failed', { worktree_path: worktreePath })
  }

  // Rebase moved HEAD. Invalidate cached inventory so the just-cleared stale
  // badge does not persist until its TTL expires.
  invalidateWorktreeInventoryCache('worktree synced')

  log('sync: done', {
    worktree_path: worktreePath,
    source_branch: sourceBranch,
    precise_base: preciseBase,
    replayed,
    dropped: droppedCount,
    base_advanced: !!sourceTip,
  })
  return { ok: true, replayed: replayed || undefined, dropped: droppedCount || undefined, warning: rebaseWarning }
}
