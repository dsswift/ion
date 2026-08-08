import { runGit } from '../git-runner'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'bench.resolution.validation'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export type ResolutionValidation =
  | { ok: true; unmergedPaths: [] }
  | { ok: false; unmergedPaths: string[]; probeError?: string; stagedCheckError?: string }

export type RererePathResult =
  | { ok: true; paths: string[] }
  | { ok: false; error: string }

export type ForgetRerereResult =
  | { ok: true; forgottenPaths: string[] }
  | { ok: false; error: string; path: string; forgottenPaths: string[] }
  /**
   * `git rerere forget` requires an active conflict (MERGE_HEAD present) to
   * identify which recording a path belongs to. Called with no merge open, it
   * is a silent no-op: the command exits 0, forgets nothing, and the
   * proof-of-forget check below (`recording_forgotten`) can never observe a
   * change either, because `git rerere status` is empty outside a merge for
   * the same reason. A caller outside a merge context must see this refusal
   * rather than an `ok: true` it would misread as "nothing needed forgetting".
   */
  | { ok: false; noContext: true; forgottenPaths: [] }

function paths(raw: string): string[] {
  return raw.split('\n').map((path) => path.trim()).filter(Boolean)
}

function uniquePaths(...groups: string[][]): string[] {
  return [...new Set(groups.flat())]
}

/**
 * Paths BOTH sides of an in-progress merge independently changed since their
 * common ancestor — the set that could plausibly have collided.
 *
 * ── Why this, and not "the incoming commit's own range" ─────────────────────
 * A first attempt at scoping used `merge-base(HEAD, MERGE_HEAD)..MERGE_HEAD`
 * (the incoming side's own full contribution). That is wrong for exactly the
 * shape the real incident has: a member's own branch is large (tens of
 * commits, hundreds of files) and only ONE file in that whole range actually
 * collides with the base branch — every other file the member touched is a
 * clean two-way add or edit that never conflicted. Scoping to the incoming
 * side's own range still includes every one of those clean files, so it does
 * not narrow anything for the case that matters. Confirmed directly against
 * real git: a 20-file member branch with one genuine conflict reproduces
 * `rerere status` and even the raw `.git/MERGE_RR` record going EMPTY once
 * `rerere.autoUpdate` fully auto-stages the resolved file — the exact
 * production shape (`unmerged_count: 0`, `rerere_status_paths: []` in the
 * confirmed incident log) — while the "both sides changed" intersection
 * computed here still correctly isolates just that one file, because the
 * clean files were only ever touched by one side of the merge.
 *
 * A path can only be a genuine collision if BOTH `HEAD` and `MERGE_HEAD`
 * independently diverged from their merge base at that path — a clean
 * two-way add or edit is, by definition, a change on exactly one side.
 * Confirmed directly for both a content conflict and an add/add conflict
 * (each alongside a batch of clean files in the same commit): the
 * intersection names exactly the conflicting path in both cases.
 */
async function bothSidesChangedPaths(benchPath: string): Promise<Set<string>> {
  const range = (await runGit(benchPath, ['merge-base', 'HEAD', 'MERGE_HEAD'])).trim()
  const [ours, theirs] = await Promise.all([
    runGit(benchPath, ['diff', '--name-only', range, 'HEAD']).then(paths),
    runGit(benchPath, ['diff', '--name-only', range, 'MERGE_HEAD']).then(paths),
  ])
  const oursSet = new Set(ours)
  return new Set(theirs.filter((p) => oursSet.has(p)))
}

/** Validate index state before any machinery commits an attempted resolution. */
export async function validateBenchResolution(
  benchPath: string,
  context: string,
): Promise<ResolutionValidation> {
  let unmergedPaths: string[]
  try {
    unmergedPaths = paths(await runGit(benchPath, ['diff', '--name-only', '--diff-filter=U']))
  } catch (err) {
    const probeError = err instanceof Error ? err.message : String(err)
    warn('resolution validation could not inspect unmerged index', {
      bench_path: benchPath,
      context,
      error: probeError,
    })
    return { ok: false, unmergedPaths: [], probeError }
  }

  if (unmergedPaths.length > 0) {
    log('resolution validation rejected unmerged index', {
      bench_path: benchPath,
      context,
      unmerged_count: unmergedPaths.length,
      unmerged_paths: unmergedPaths,
    })
    return { ok: false, unmergedPaths }
  }

  try {
    // Scoped to paths BOTH sides of the merge independently changed since
    // their common ancestor, when MERGE_HEAD is present. An unrelated staged
    // file elsewhere in the merge — trailing whitespace, or legitimate prose
    // that happens to contain marker-shaped lines, both confirmed directly —
    // must never fail a check that has nothing to do with the resolution
    // actually being validated. See `bothSidesChangedPaths`'s doc comment for
    // why this intersection, not the incoming commit's own range, is the
    // correct bound: a file only one side touched can never have conflicted,
    // however large that side's own range is. Falls back to the unscoped
    // check when there is no MERGE_HEAD to compute the intersection against
    // (a post-commit caller, or no merge context) — matching the prior,
    // always-unscoped behavior exactly, so nothing regresses for a caller
    // with no range to compute.
    let checkArgs = ['diff', '--cached', '--check']
    try {
      const collidable = await bothSidesChangedPaths(benchPath)
      if (collidable.size > 0) checkArgs = ['diff', '--cached', '--check', '--', ...collidable]
    } catch {
      // No MERGE_HEAD, or the range could not be computed: unscoped check.
    }
    await runGit(benchPath, checkArgs)
    log('resolution validation passed', {
      bench_path: benchPath,
      context,
      unmerged_count: 0,
      staged_check: 'passed',
    })
    return { ok: true, unmergedPaths: [] }
  } catch (err) {
    const stagedCheckError = err instanceof Error ? err.message : String(err)
    warn('resolution validation rejected staged content', {
      bench_path: benchPath,
      context,
      unmerged_count: 0,
      staged_check: 'failed',
      error: stagedCheckError,
    })
    return { ok: false, unmergedPaths: [], stagedCheckError }
  }
}

/**
 * Capture every path that can represent current rerere conflict context.
 *
 * `git rerere status` becomes empty after `rerere.autoUpdate` fully stages a
 * replay. While MERGE_HEAD exists, staged paths are therefore required
 * candidates. `git rerere forget` safely ignores staged paths without a rerere
 * record, while omitting them can leave poisoned full replays undiscoverable.
 *
 * ── Scoped to paths both sides changed, not every staged file ───────────────
 * The naive fallback (`git diff --cached --name-only`, no pathspec) lists
 * EVERY staged file in the merge — including every file the member's own
 * branch cleanly added or edited, which never conflicted. Confirmed as the
 * direct, exact cause of a real incident: a 40+-commit member branch with one
 * genuine conflict produced a 216-line "checked invalid rerere recording" log
 * storm, one wasted no-op `rerere forget` per unrelated file, precisely
 * because `rerere status` (and even the raw `.git/MERGE_RR` record) go EMPTY
 * once autoUpdate fully auto-stages the one real conflict — the exact
 * production shape confirmed in the incident log
 * (`rerere_status_paths: []`, `unmerged_count: 0`). Intersecting the staged
 * list with `bothSidesChangedPaths` bounds the candidate set to paths that
 * could plausibly have collided — see that function's doc comment for why
 * this intersection (not the incoming commit's own range) is the correct,
 * confirmed bound. Falls back to the unscoped list when the intersection
 * cannot be computed, so a probe failure degrades to the old (safe, if
 * noisy) behavior rather than silently capturing nothing.
 */
export async function currentRererePaths(benchPath: string): Promise<RererePathResult> {
  try {
    const rererePaths = paths(await runGit(benchPath, ['rerere', 'status']))
    // Every recovery caller operates inside a merge. Requiring MERGE_HEAD
    // prevents an empty status result after context cleanup from looking safe.
    await runGit(benchPath, ['rev-parse', '--verify', 'MERGE_HEAD'])
    const allStaged = paths(await runGit(benchPath, ['diff', '--cached', '--name-only']))

    let stagedPaths: string[]
    try {
      const collidable = await bothSidesChangedPaths(benchPath)
      stagedPaths = allStaged.filter((p) => collidable.has(p))
    } catch (scopeErr) {
      log('rerere path scoping unavailable, falling back to every staged file', {
        bench_path: benchPath, error: String(scopeErr),
      })
      stagedPaths = allStaged
    }

    const capturedPaths = uniquePaths(rererePaths, stagedPaths)
    log('captured rerere recovery paths', {
      bench_path: benchPath,
      rerere_status_paths: rererePaths,
      staged_merge_paths: stagedPaths,
      rerere_paths: capturedPaths,
    })
    return { ok: true, paths: capturedPaths }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    warn('could not capture rerere paths', { bench_path: benchPath, error })
    return { ok: false, error }
  }
}

/**
 * Forget only poisoned recordings identified in current conflict context.
 *
 * Requires MERGE_HEAD: `git rerere forget` identifies which recording covers a
 * path from the CURRENT conflict, so calling it once the merge has already
 * committed (no MERGE_HEAD) cannot forget anything — it silently no-ops. That
 * gap was a real defect: a post-verify caller with no merge open received
 * `ok: true, forgottenPaths: []` on every path and reported a discard that never
 * happened. Checking MERGE_HEAD first turns that into an explicit refusal.
 */
export async function forgetRererePaths(
  benchPath: string,
  rererePaths: string[],
): Promise<ForgetRerereResult> {
  try {
    await runGit(benchPath, ['rev-parse', '--verify', 'MERGE_HEAD'])
  } catch {
    warn('forget refused: no merge in progress to forget within', {
      bench_path: benchPath,
      requested_paths: rererePaths.length,
    })
    return { ok: false, noContext: true, forgottenPaths: [] }
  }

  const forgottenPaths: string[] = []
  for (const path of rererePaths) {
    try {
      await runGit(benchPath, ['rerere', 'forget', '--', path])
      // Proof of forget: with a recording gone, the path's hunk is once again
      // an unresolved conflict, which is exactly what makes `rerere status`
      // list it. This proof is only valid HERE, inside the merge context just
      // verified above -- outside a merge `rerere status` is unconditionally
      // empty, which is the exact ambiguity the MERGE_HEAD check above removes.
      const activePaths = paths(await runGit(benchPath, ['rerere', 'status']))
      const recordingForgotten = activePaths.includes(path)
      if (recordingForgotten) forgottenPaths.push(path)
      log('checked invalid rerere recording', {
        bench_path: benchPath,
        path,
        recording_forgotten: recordingForgotten,
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      warn('could not forget invalid rerere recording', {
        bench_path: benchPath,
        path,
        error,
        forgotten_paths: forgottenPaths,
      })
      return { ok: false, error, path, forgottenPaths }
    }
  }
  return { ok: true, forgottenPaths }
}
