/**
 * Patch identity — deciding which commits in a worktree's replay range are
 * already present in the source branch, by content rather than by sha.
 *
 * ── The defect this exists to fix ───────────────────────────────────────────
 * `syncWorktreeFromSource` rebases with `git rebase --onto <source> <storedBase>`
 * so that only the worktree's OWN commits replay (see integrate.ts for why the
 * stored base beats a merge-base guess). Git has two mechanisms for not
 * replaying a commit whose content is already upstream, and the precise path
 * keeps only the weaker one:
 *
 *   M1 — preemptive skip. Before replaying, git compares patch-ids across
 *        `<upstream>...HEAD` and silently omits right-side commits whose
 *        patch-id appears on the left ("skipped previously applied commit").
 *        Keyed on `<upstream>`. On the plain path `<upstream>` is the source
 *        branch and this works; on the precise path `<upstream>` is
 *        `storedBase`, an ancestor of HEAD, so the left side is EMPTY and M1
 *        can never fire.
 *   M2 — becomes-empty drop. At replay, when the 3-way merge of a commit onto
 *        the new base produces no change, non-interactive rebase drops it
 *        ("dropping <sha> ... patch contents already upstream"). Content-based,
 *        works on the precise path — but only when the merge is CLEAN.
 *
 * The gap is the case M2 cannot reach: the source branch has moved BEYOND the
 * carried commit's content. Release automation always produces this shape — the
 * worktree carries the 1.0→1.1 version bump while the source is already at 1.2
 * — and ordinary authored commits hit it whenever upstream edits the same
 * region again. The replay then CONFLICTS instead of becoming empty (call it
 * M3), and there is no automatic handling at all. What happens next is the
 * duplication factory: a conflict resolved to the replayed commit's content —
 * by hand, by an AI assist, or by a rerere recording made once and auto-replayed
 * across every sibling worktree's sync — writes an INVERSE commit (version
 * bumped down, changelog entries deleted). An inverse+forward pair replays
 * cleanly onto any base, never becomes empty, never conflicts again: every
 * later sync carries it forward verbatim, permanently. That is exactly the
 * steady state found in the wild: identical duplicate patch-id pairs in six
 * worktrees at once, spread by the rerere cascade, some landed back into the
 * source branch itself.
 *
 * ── The fix ─────────────────────────────────────────────────────────────────
 * Restore M1's semantics on the precise path, explicitly and against the
 * correct comparison set: commits in `storedBase..HEAD` whose patch-id appears
 * in `merge-base(HEAD, source)..source` are omitted from an explicit rebase
 * todo. Dropping the forward copy BEFORE replay prevents the M3 conflict from
 * ever standing, which is what closes the factory — no meaningless conflict to
 * resolve, no wrong resolution to record, no inverse pair to mint.
 *
 * What the filter deliberately does not catch:
 *   - Context-drift copies whose patch-ids differ. Those still conflict, same
 *     as they do under M1 on the plain path. An honest conflict beats a guess.
 *   - Existing inverse+forward pairs. Net-zero content matching nothing
 *     upstream; removing them retroactively is a history rewrite, which is the
 *     operator's deliberate cleanup, never an automatic sync action. The sync
 *     WARNS about them instead (`duplicate-in-range`) on every pass until they
 *     are cleaned.
 *
 * ── Why patch-id and not a bot-author/subject heuristic ─────────────────────
 * `git patch-id --stable` is git's own content identity for a diff — the exact
 * primitive M1 uses. An author/subject filter for release automation would miss
 * every authored commit that duplicates through the identical mechanism (the
 * majority of the pairs found in the wild) and would still not remove existing
 * pairs. This module restores the mechanism git itself would have applied with
 * a different `<upstream>`, not an approximation of it.
 *
 * ── Fail open, never fail destructive ───────────────────────────────────────
 * Every failure path in this module keeps commits. An unreadable range, a
 * `patch-id` that produces no line for a commit, a git invocation that dies —
 * all degrade to "pick everything", which is exactly today's behavior. A commit
 * is never dropped on absent evidence, because dropping is the irreversible
 * direction: replaying a duplicate is noise, discarding real work is data loss.
 */
import { spawn } from 'child_process'
import { runGit, withGitSlot } from '../git-runner'

/** One commit in the replay range, in rebase-todo order (oldest first). */
export interface CommitRef {
  sha: string
  subject: string
}

/** A commit omitted from the replay because the source branch already has its content. */
export interface DroppedCommit extends CommitRef {
  /** The commit on the source branch carrying the same patch-id. */
  upstreamSha: string
  /** Shared `git patch-id --stable` value, short form, for the log record. */
  patchId: string
}

/**
 * Something the plan found that the operator or a later investigation should
 * know about. Advisory: a warning never changes the pick/drop decision beyond
 * what the rules below already state.
 *
 * - `ambiguous-upstream`     — a dropped commit's patch-id matches MORE THAN ONE
 *                              upstream commit, i.e. the source branch itself
 *                              carries duplicate content.
 * - `duplicate-in-range`     — two commits IN the replay range share a patch-id.
 *                              Both are kept: an add / revert / re-add sequence
 *                              legitimately contains patch-identical commits, so
 *                              collapsing them would destroy real history. This
 *                              is how already-accumulated pollution announces
 *                              itself without the sync silently rewriting it.
 * - `patch-id-unavailable`   — a commit produced no patch-id line. Kept.
 * - `probe-failed`           — a git invocation failed; the whole plan degraded
 *                              to picking everything.
 */
export interface ReplayWarning {
  kind: 'ambiguous-upstream' | 'duplicate-in-range' | 'patch-id-unavailable' | 'probe-failed'
  message: string
  /** Commits the warning concerns, short shas, for the structured log field. */
  shas: string[]
  /** Present on `probe-failed`. */
  error?: string
}

/** The decision: what to replay, what to omit, and what was noticed on the way. */
export interface ReplayPlan {
  /** Commits to `pick`, oldest first — the rebase todo, in order. */
  pick: CommitRef[]
  /** Commits omitted because their content is already on the source branch. */
  dropped: DroppedCommit[]
  warnings: ReplayWarning[]
  /** Total commits in the replay range (`pick.length + dropped.length`). */
  rangeSize: number
  /**
   * False when any probe failed and the plan degraded to picking everything.
   * The caller uses this to log the degradation and to decline the filtered-todo
   * path in favour of the plain rebase it would have run anyway.
   */
  reliable: boolean
}

/**
 * Map every commit in `range` to its `git patch-id --stable` value.
 *
 * Two processes joined by an OS pipe — `git log -p` streaming into
 * `git patch-id` — rather than a `git show | git patch-id` pair per commit. That
 * matters twice over. First, an inventory crawl over a couple dozen worktrees at
 * a few dozen commits each would otherwise spawn thousands of subprocesses on
 * the Electron main thread's event loop, which is precisely the spawn storm
 * documented in git-runner.ts that froze the overlay. Second, the diff stream
 * for a large range is tens of megabytes; piping it kernel-to-kernel keeps it
 * out of the main process's heap entirely, so only the small
 * `<patchId> <sha>` result is ever buffered.
 *
 * No shell is involved: `spawn` with an argument array cannot word-split or
 * expand a branch name, so a ref containing a shell metacharacter is inert.
 *
 * `patch-id` reads a diff stream and emits `<patchId> <commitSha>` per commit it
 * can identify, skipping commits with no diff (a merge, an empty commit). So the
 * returned map is deliberately allowed to be missing entries — callers treat an
 * absent patch-id as "unknown, keep it", never as "no content".
 *
 * Returns null when either process fails or the pipeline errors, which the
 * caller turns into a `probe-failed` warning and a pick-everything plan.
 */
export async function patchIdsIn(
  directory: string,
  range: string,
): Promise<Map<string, string[]> | null> {
  const raw = await withGitSlot(() => new Promise<string | null>((resolve) => {
    // --no-merges: a merge commit has no single diff for patch-id to identify,
    // and a merge is never a candidate for content-equivalence dropping.
    const producer = spawn('git', ['log', '--no-merges', '-p', range], { cwd: directory })
    const consumer = spawn('git', ['patch-id', '--stable'], { cwd: directory })

    let out = ''
    let failed = false
    /** Resolve exactly once, whichever of the two exits or errors first. */
    let settled = false
    const settle = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    producer.stdout.pipe(consumer.stdin)
    consumer.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })

    // A producer failure means the range is unreadable — the result would be a
    // silent PARTIAL map, which is the one outcome that could drop a commit on
    // incomplete evidence. Treat it as a failed probe.
    producer.on('error', () => { failed = true; settle(null) })
    consumer.on('error', () => { failed = true; settle(null) })
    producer.on('close', (code) => { if (code !== 0) failed = true })
    consumer.on('close', (code) => { settle(code === 0 && !failed ? out : null) })
  }))

  if (raw === null) return null

  const byPatchId = new Map<string, string[]>()
  for (const line of raw.split('\n')) {
    const [patchId, sha] = line.trim().split(/\s+/)
    if (!patchId || !sha) continue
    const existing = byPatchId.get(patchId)
    if (existing) existing.push(sha)
    else byPatchId.set(patchId, [sha])
  }
  return byPatchId
}

/** Commits in `range`, oldest first, with subjects. */
async function commitsIn(directory: string, range: string): Promise<CommitRef[] | null> {
  try {
    const raw = await runGit(directory, ['log', '--reverse', '--format=%H%x00%s', range])
    const commits: CommitRef[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      const [sha, subject] = line.split('\x00')
      if (sha) commits.push({ sha, subject: subject ?? '' })
    }
    return commits
  } catch {
    return null
  }
}

export interface ReplayPlanOptions {
  directory: string
  /** Start of the replay range: the source-branch commit this worktree is based on. */
  storedBase: string
  /** The branch being rebased onto. */
  sourceBranch: string
}

/**
 * Decide which of `storedBase..HEAD` still needs replaying onto `sourceBranch`.
 *
 * The comparison set is `merge-base(HEAD, sourceBranch)..sourceBranch` — every
 * commit the source branch has gained since this worktree's true fork point.
 * That is the set `git rebase <sourceBranch>` would have compared against on the
 * plain path, which is why the plain path never exhibited this defect.
 *
 * Drop rule, stated exactly: a commit is dropped when its patch-id appears in
 * the upstream set AND no other commit in the replay range shares that patch-id.
 * The second clause is the add/revert/re-add carve-out — when the range itself
 * contains two patch-identical commits, they are a legitimate pair (or existing
 * pollution) whose collapse would change the branch's net content, so both are
 * kept and a `duplicate-in-range` warning is raised for the operator instead.
 */
export async function computeReplayPlan(opts: ReplayPlanOptions): Promise<ReplayPlan> {
  const { directory, storedBase, sourceBranch } = opts
  const warnings: ReplayWarning[] = []

  const range = `${storedBase}..HEAD`
  const commits = await commitsIn(directory, range)
  if (!commits) {
    return {
      pick: [],
      dropped: [],
      warnings: [{
        kind: 'probe-failed',
        message: `Could not list the replay range ${range}; every commit will be replayed.`,
        shas: [],
      }],
      rangeSize: 0,
      reliable: false,
    }
  }

  const pickEverything = (warning: ReplayWarning): ReplayPlan => ({
    pick: commits,
    dropped: [],
    warnings: [...warnings, warning],
    rangeSize: commits.length,
    reliable: false,
  })

  // The true fork point, not the stored base: the stored base can lag behind
  // what HEAD is actually built on (see base-repair.ts), and comparing against
  // too SHORT an upstream range would under-drop, leaving duplicates behind.
  let forkPoint: string
  try {
    forkPoint = (await runGit(directory, ['merge-base', 'HEAD', sourceBranch])).trim()
  } catch (err) {
    return pickEverything({
      kind: 'probe-failed',
      message: `Could not compute the fork point against ${sourceBranch}; every commit will be replayed.`,
      shas: [],
      error: String(err),
    })
  }

  const upstream = await patchIdsIn(directory, `${forkPoint}..${sourceBranch}`)
  if (!upstream) {
    return pickEverything({
      kind: 'probe-failed',
      message: `Could not read patch identities for ${forkPoint.slice(0, 7)}..${sourceBranch}; every commit will be replayed.`,
      shas: [],
    })
  }

  const mine = await patchIdsIn(directory, range)
  if (!mine) {
    return pickEverything({
      kind: 'probe-failed',
      message: `Could not read patch identities for ${range}; every commit will be replayed.`,
      shas: [],
    })
  }

  // Invert the range's map so a commit can be asked for its own patch-id, and
  // count how many commits in the range share each one.
  const patchIdBySha = new Map<string, string>()
  for (const [patchId, shas] of mine) {
    for (const sha of shas) patchIdBySha.set(sha, patchId)
  }

  for (const [patchId, shas] of mine) {
    if (shas.length > 1) {
      warnings.push({
        kind: 'duplicate-in-range',
        message:
          `${shas.length} commits in this worktree's own range share patch identity ${patchId.slice(0, 12)}. ` +
          'All are kept — a change made, reverted, and remade is legitimately patch-identical, so they are ' +
          'never collapsed automatically. If this is leftover duplication from an earlier sync, clean it up ' +
          'deliberately.',
        shas: shas.map((s) => s.slice(0, 9)),
      })
    }
  }

  const pick: CommitRef[] = []
  const dropped: DroppedCommit[] = []

  for (const commit of commits) {
    const patchId = patchIdBySha.get(commit.sha)
    if (!patchId) {
      // No diff identity (a merge, an empty commit) or patch-id said nothing
      // about it. Keep it: absent evidence never drops a commit.
      warnings.push({
        kind: 'patch-id-unavailable',
        message: `No patch identity for ${commit.sha.slice(0, 9)}; it will be replayed.`,
        shas: [commit.sha.slice(0, 9)],
      })
      pick.push(commit)
      continue
    }

    const upstreamShas = upstream.get(patchId)
    if (!upstreamShas || upstreamShas.length === 0) {
      pick.push(commit)
      continue
    }

    // The add/revert/re-add carve-out: this patch-id occurs more than once in
    // the worktree's own range, so the commits are a sequence whose net effect
    // depends on all of them. Dropping one would change the branch's content.
    const occurrencesInRange = mine.get(patchId)?.length ?? 1
    if (occurrencesInRange > 1) {
      pick.push(commit)
      continue
    }

    if (upstreamShas.length > 1) {
      warnings.push({
        kind: 'ambiguous-upstream',
        message:
          `${commit.sha.slice(0, 9)} matches ${upstreamShas.length} commits on ${sourceBranch} with patch identity ` +
          `${patchId.slice(0, 12)} — the source branch carries duplicate content. Dropping it regardless: its ` +
          'content is present upstream either way.',
        shas: upstreamShas.map((s) => s.slice(0, 9)),
      })
    }

    dropped.push({
      ...commit,
      upstreamSha: upstreamShas[0],
      patchId: patchId.slice(0, 12),
    })
  }

  return { pick, dropped, warnings, rangeSize: commits.length, reliable: true }
}
