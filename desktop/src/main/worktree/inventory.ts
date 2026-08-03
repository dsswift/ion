/**
 * Worktree inventory — the answer to "what worktrees exist here, and how do I
 * get back into one?"
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 * Closing a worktree conversation used to be a trap. `closeTab` force-removed
 * the worktree, so an accidental close destroyed the work outright. Even once
 * close stops destroying anything (it does now — see the close guard), the
 * conversation is gone and there is no history feature to recover it. The only
 * way back in was to create a tab and manually browse to a path like
 * `~/.ion/worktrees/ion-a3f1` that the operator has no reason to know.
 *
 * So the worktree has to be *discoverable*: list what exists for this repo,
 * with enough state to tell them apart, and let the operator open a fresh
 * conversation directly into one. That is strictly better than forbidding close,
 * which would pin the operator to a single immortal conversation per worktree.
 *
 * ── Source-branch resolution ────────────────────────────────────────────────
 * Every lifecycle verb (land, sync, base staleness) needs to know which branch a
 * worktree was cut FROM, and git does not record that. A worktree created by
 * Ion registers itself here, so the answer is durable and exact.
 *
 * When a worktree has no registry entry — created before this existed, or by
 * hand on the command line — the source branch is REPORTED AS UNKNOWN rather
 * than guessed. A wrong source branch would make "land" merge into the wrong
 * place, which is far worse than asking. Callers surface a picker instead.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { log as _log, warn as _warn } from '../logger'
import { runGit } from '../git-runner'
import { parseWorktreeList } from './integrate'
import {
  appraiseRefPair, commitSubject, pruneAppraisalCache, type AppraisalCounters,
} from './inventory-appraise'
import { invalidateWorktreeInventoryCache } from './inventory-cache'
import { getProvisionState } from './provision-state'
import { probeOperationState } from '../git/operation-state'
import type { WorktreeInventoryEntry } from '../../shared/types'

const TAG = 'worktree.inventory'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

// Resolved lazily, not captured at module load: a frozen path is unobservable
// and would make a test that redirects HOME write to the real ~/.ion.
function ionDir(): string { return join(homedir(), '.ion') }
export function worktreeRegistryFile(): string { return join(ionDir(), 'worktree-registry.json') }

interface RegistryEntry {
  worktreePath: string
  repoPath: string
  branchName: string
  /**
   * The branch this worktree was cut from — not recoverable from git.
   *
   * Null for a worktree Ion knows about but did not cut (a hand-created one
   * that has since been given a title, see `setWorktreeTitle`). Recording a
   * title must never require inventing a source branch: a wrong one would make
   * `land` merge into the wrong place, which is exactly what the unknown-source
   * path exists to prevent.
   */
  sourceBranch: string | null
  /**
   * Human-readable description of what this worktree is FOR.
   *
   * Seeded from the conversation that started the worktree: either the name it
   * already had when it was converted into one, or the title generated for its
   * first real prompt (see the seed IPC). Written ONCE — later conversations
   * opened in the same worktree never change it, because a worktree's topic is
   * set by the work it was cut for. The operator can override it explicitly.
   *
   * Absent until then. Every other identifier a worktree has — `ion-03e81090`,
   * `wt/ion-03e81090`, a commit sha — is a machine string that tells the
   * operator nothing about the work, which is what this field fixes.
   */
  title?: string
  createdAt: number
  /**
   * When this worktree's commits were landed into its source branch.
   *
   * ── Why this is STORED and not derived ──────────────────────────────────
   * "Has landed" cannot be answered by any git query after the fact. A worktree
   * that never committed anything and one whose work landed both end up clean,
   * with zero commits in `sourceBranch..branch`, and a tip equal to their merge
   * base with the source. Fork-point, ancestry and merge-base probes all
   * collapse to the same answer for both.
   *
   * This is the same trap `IntegrationMember.pinnedBaseSha` documents for bench
   * members, where the bench once read "never started" as "landed" and deleted
   * the member. The fix there was also a stored fact captured at the moment it
   * was still knowable.
   *
   * The land verb is the only code that witnesses the transition, so it is the
   * only place this is written. Absent means NOT landed -- never "unknown, guess"
   * -- which is what keeps a freshly created empty worktree out of the landed
   * band. A worktree landed before this field existed reads as active until it
   * is retired; that degrades honestly, where inferring would not.
   */
  landedAt?: number
}

interface RegistryFile {
  version: 1
  entries: RegistryEntry[]
}

function loadRegistry(): RegistryEntry[] {
  const file = worktreeRegistryFile()
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<RegistryFile>
    return Array.isArray(parsed.entries)
      ? parsed.entries.filter((e): e is RegistryEntry =>
        // sourceBranch may legitimately be null: a hand-created worktree that
        // has been titled is registered with an unknown source rather than a
        // guessed one. Requiring a string here would silently drop those
        // entries on the next read, losing the title.
        !!e && typeof e.worktreePath === 'string'
        && (typeof e.sourceBranch === 'string' || e.sourceBranch === null))
      : []
  } catch (err) {
    warn('registry unreadable, treating as empty', { path: file, error: String(err) })
    return []
  }
}

function saveRegistry(entries: RegistryEntry[]): void {
  try {
    const dir = ionDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const payload: RegistryFile = { version: 1, entries }
    atomicWriteFileSync(worktreeRegistryFile(), JSON.stringify(payload, null, 2), 0o644)
  } catch (err) {
    warn('failed to save worktree registry', { path: worktreeRegistryFile(), error: String(err) })
  }
}

/**
 * Record a worktree's source branch. Called from every path that creates a
 * worktree, so the lifecycle verbs always know where it lands.
 *
 * An existing TITLE survives re-registration, and always wins over the `title`
 * argument. Re-registering happens when a worktree is re-attached at the same
 * path, and the description of what the work is about is still true — dropping
 * it would silently un-name the row.
 *
 * `title` is the SEED: the name of the conversation this worktree was cut for,
 * passed by the creation paths that already have one (converting a named
 * conversation into a worktree, re-attaching a live one). A worktree cut before
 * its conversation has any name — the panel's "New worktree" button, a fresh
 * tab — passes nothing and is named later by its first prompt. Because a
 * stored title always wins, a seed can never overwrite a name the worktree
 * already carries.
 */
export function registerWorktree(args: {
  worktreePath: string
  repoPath: string
  branchName: string
  sourceBranch: string
  title?: string
}): void {
  const previous = loadRegistry().find((e) => e.worktreePath === args.worktreePath)
  const entries = loadRegistry().filter((e) => e.worktreePath !== args.worktreePath)
  const seeded = args.title?.trim() || undefined
  // `landedAt` is carried across a re-registration: the same directory being
  // re-registered has not un-landed its history.
  entries.push({
    worktreePath: args.worktreePath,
    repoPath: args.repoPath,
    branchName: args.branchName,
    sourceBranch: args.sourceBranch,
    title: previous?.title ?? seeded,
    landedAt: previous?.landedAt,
    createdAt: Date.now(),
  })
  saveRegistry(entries)
  invalidateWorktreeInventoryCache('worktree registered')
  log('registered worktree', {
    worktree_path: args.worktreePath,
    branch: args.branchName,
    source_branch: args.sourceBranch,
    retained_title: previous?.title ?? '',
    seeded_title: previous?.title ? '' : (seeded ?? ''),
  })
}

/**
 * Record that a worktree's commits reached its source branch.
 *
 * Called only from the land path, which is the only code that can witness the
 * transition -- see the `landedAt` field comment for why it cannot be derived
 * afterwards. Idempotent: landing twice keeps the FIRST timestamp, because that
 * is when the work actually arrived.
 *
 * A worktree with no registry entry is not created here. Landing one implies it
 * was registered, and inventing an entry with a fabricated `sourceBranch` is the
 * failure mode the registry's null-source rule exists to prevent.
 */
export function markWorktreeLanded(worktreePath: string): void {
  const entries = loadRegistry()
  const existing = entries.find((e) => e.worktreePath === worktreePath)
  if (!existing) {
    warn('cannot mark landed, no registry entry', { worktree_path: worktreePath })
    return
  }
  if (existing.landedAt) {
    log('worktree already marked landed', {
      worktree_path: worktreePath, landed_at: existing.landedAt,
    })
    return
  }
  existing.landedAt = Date.now()
  saveRegistry(entries)
  invalidateWorktreeInventoryCache('worktree landed')
  log('worktree marked landed', { worktree_path: worktreePath, landed_at: existing.landedAt })
}

/**
 * Give a worktree a human-readable title, creating a registry entry when one
 * does not exist yet.
 *
 * The upsert matters: a worktree created by hand on the command line has no
 * registry entry, but it still shows up in the inventory and still deserves a
 * name. Such an entry records `sourceBranch: null` — Ion genuinely does not
 * know what it was cut from, and the lifecycle verbs must keep asking rather
 * than acting on a fabricated answer.
 *
 * `repoPath` and `branchName` are optional because a titling caller may not
 * know them; they are only filled in when creating a new entry, never used to
 * overwrite what an existing registration already recorded.
 */
export function setWorktreeTitle(
  worktreePath: string,
  title: string,
  fallback?: { repoPath?: string; branchName?: string },
): void {
  const entries = loadRegistry()
  const existing = entries.find((e) => e.worktreePath === worktreePath)
  if (existing) {
    const previous = existing.title
    existing.title = title
    saveRegistry(entries)
    invalidateWorktreeInventoryCache('worktree titled')
    log('worktree title set', { worktree_path: worktreePath, title, replaced: previous ?? '' })
    return
  }

  entries.push({
    worktreePath,
    repoPath: fallback?.repoPath ?? '',
    branchName: fallback?.branchName ?? '',
    // Unknown, and deliberately not guessed. See the field comment.
    sourceBranch: null,
    title,
    createdAt: Date.now(),
  })
  saveRegistry(entries)
  invalidateWorktreeInventoryCache('worktree titled')
  log('worktree title set on a new registry entry', {
    worktree_path: worktreePath,
    title,
    repo_path: fallback?.repoPath ?? '',
    source_branch: 'unknown',
  })
}

/** A worktree's recorded title, or null when it has never been named. */
export function lookupWorktreeTitle(worktreePath: string): string | null {
  return loadRegistry().find((e) => e.worktreePath === worktreePath)?.title ?? null
}

/** When this worktree's work landed, or null when it has not (or Ion has no record). */
export function lookupWorktreeLandedAt(worktreePath: string): number | null {
  return loadRegistry().find((e) => e.worktreePath === worktreePath)?.landedAt ?? null
}

/**
 * The full registration for a worktree, or null when Ion has no record.
 *
 * Callers that must decide "is this directory a worktree Ion manages, and which
 * repo does it belong to" read this rather than inferring from the path shape —
 * a path can look like a worktree without being one.
 */
export function lookupWorktreeRegistration(worktreePath: string): {
  repoPath: string
  branchName: string
  sourceBranch: string | null
  title: string | null
} | null {
  const entry = loadRegistry().find((e) => e.worktreePath === worktreePath)
  if (!entry) return null
  return {
    repoPath: entry.repoPath,
    branchName: entry.branchName,
    sourceBranch: entry.sourceBranch,
    title: entry.title ?? null,
  }
}

/** Drop a worktree's registry entry (after a retire). */
export function unregisterWorktree(worktreePath: string): void {
  const before = loadRegistry()
  const after = before.filter((e) => e.worktreePath !== worktreePath)
  if (after.length !== before.length) {
    saveRegistry(after)
    invalidateWorktreeInventoryCache('worktree unregistered')
    log('unregistered worktree', { worktree_path: worktreePath })
  }
}

/** Look up a worktree's recorded source branch, or null when unknown. */
export function lookupSourceBranch(worktreePath: string): string | null {
  return loadRegistry().find((e) => e.worktreePath === worktreePath)?.sourceBranch ?? null
}

/**
 * One worktree, with everything the UI needs to describe and act on it.
 *
 * Re-exported from `shared/types-git` rather than declared here. This used to be
 * a second, hand-maintained copy of the same shape; two declarations of one wire
 * contract drift the moment a field is added to only one of them (which is
 * exactly what happened when `provisionState` was introduced). The shared file
 * is the single definition, and this export keeps the existing import paths in
 * this package working.
 */
export type { WorktreeInventoryEntry } from '../../shared/types'

/**
 * List every managed worktree for a repo, enriched with the state needed to
 * pick one and act on it. Read-only.
 *
 * The bench worktree and the repo's own root are excluded: they are not feature
 * worktrees and offering them here would be misleading.
 *
 * ── Crawl budget ────────────────────────────────────────────────────────────
 * This is the desktop's most-repeated git surface (two windows poll it while
 * the panel is open, plus the iOS projection), so its subprocess count is a
 * first-class property: two fixed spawns (`worktree list`, `for-each-ref`)
 * plus one `status --porcelain` per worktree, with the land-relative facts
 * answered by the sha-keyed cache in inventory-appraise.ts (zero spawns until
 * a ref actually moves). It previously ran ~8 spawns per worktree per crawl,
 * which is what let overlapping crawls freeze the overlay. Callers should
 * reach this through inventory-service.ts, which coalesces concurrent crawls.
 */
export async function inventoryWorktrees(
  repoPath: string,
): Promise<WorktreeInventoryEntry[]> {
  return (await inventoryWorktreesDetailed(repoPath)).entries
}

/**
 * The crawl result plus the identity facts the caching service needs:
 * `git worktree list` answers identically from ANY checkout of the repo, so
 * every listed path is an alias for the same inventory and the MAIN worktree
 * (always listed first) is its canonical cache key.
 */
export interface WorktreeInventoryResult {
  /** The repo's main working-tree path, or null when the listing failed. */
  canonicalRepoPath: string | null
  /** Every listed checkout path (main, bench, features) — the alias set. */
  aliasPaths: string[]
  entries: WorktreeInventoryEntry[]
}

/** `inventoryWorktrees` with the canonical/alias identity attached. */
export async function inventoryWorktreesDetailed(
  repoPath: string,
): Promise<WorktreeInventoryResult> {
  const startedAt = Date.now()
  let listed: ReturnType<typeof parseWorktreeList>
  try {
    listed = parseWorktreeList(await runGit(repoPath, ['worktree', 'list', '--porcelain']))
  } catch (err) {
    warn('could not list worktrees', { repo_path: repoPath, error: String(err) })
    return { canonicalRepoPath: null, aliasPaths: [], entries: [] }
  }

  // Every source branch's tip in one spawn. A worktree whose source branch is
  // missing from this map gets no land-relative answers and fails CLOSED on
  // `safeToDiscard` — same contract as the appraisal it replaces.
  const branchTips = new Map<string, string>()
  try {
    const raw = await runGit(repoPath, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'])
    for (const line of raw.split('\n')) {
      const sep = line.lastIndexOf(' ')
      if (sep > 0) branchTips.set(line.slice(0, sep), line.slice(sep + 1).trim())
    }
  } catch (err) {
    warn('could not read branch tips; land-relative facts will fail closed', {
      repo_path: repoPath, error: String(err),
    })
  }

  const counters: AppraisalCounters = { hits: 0, misses: 0 }
  const entries: WorktreeInventoryEntry[] = []
  for (const [index, wt] of listed.entries()) {
    // Skip the repo's main working tree and the integration bench: neither is
    // a feature worktree, and offering them navigates the operator to the
    // wrong place. Git guarantees the MAIN worktree is listed first, which is
    // the identity check that holds no matter which checkout ran the query.
    // The previous check compared against `repoPath` — but this inventory is
    // also queried from inside a worktree or bench tab, where `repoPath` is
    // that checkout's own path: the main clone slipped through as a stray row,
    // and a worktree would have dropped ITSELF from its own panel.
    if (index === 0) continue
    if (wt.branch.startsWith('ion/bench/')) continue

    // A detached HEAD is usually not a managed feature worktree — but a
    // conflicted rebase detaches HEAD too, and dropping the entry in that state
    // made two mid-rebase worktrees vanish from the panel at the exact moment
    // the operator needed to see them. Probe for an in-progress operation and
    // recover the branch git recorded (rebase-merge/head-name) before skipping.
    let branchName = wt.branch
    const operation = await probeOperationState(wt.path)
    if (!branchName) {
      if (operation.state && operation.branch) {
        branchName = operation.branch
        log('recovered mid-operation worktree', {
          worktree_path: wt.path,
          branch: branchName,
          operation: operation.state,
          conflicted: operation.conflictedPaths.length,
        })
      } else {
        // Genuinely detached (operator checkout, bisect artifact) — not ours.
        log('skipping detached worktree with no recorded operation', { worktree_path: wt.path })
        continue
      }
    }

    const sourceBranch = lookupSourceBranch(wt.path)
    const title = lookupWorktreeTitle(wt.path)
    const landedAt = lookupWorktreeLandedAt(wt.path)

    // Subject is a pure function of the HEAD sha, so it caches under it. A
    // listing entry without a HEAD (prunable/broken checkout) has no commit to
    // describe — skip the lookup rather than handing git an empty sha.
    const lastCommitSubject = wt.head ? await commitSubject(wt.path, wt.head) : ''

    // Without a known source branch the land-relative facts are unanswerable.
    // Report what IS knowable and leave the rest conservative. A mid-operation
    // worktree also skips the appraisals: unlanded counts and needsSync are
    // meaningless halfway through a rebase, and their git reads can fail — the
    // operation itself is the state worth reporting.
    let unlandedCommitCount = 0
    let safeToDiscard = false
    let needsSync = false
    let isDirty = false
    if (!operation.state) {
      // The one per-worktree spawn that cannot be sha-cached: uncommitted
      // state has no ref to key on.
      try {
        isDirty = (await runGit(wt.path, ['status', '--porcelain', '-uall'])).trim().length > 0
      } catch (err) {
        log('could not read status', { worktree_path: wt.path, error: String(err) })
      }
    }
    const sourceTip = sourceBranch ? branchTips.get(sourceBranch) : undefined
    if (sourceBranch && sourceTip && wt.head && !operation.state) {
      const pair = await appraiseRefPair(wt.path, wt.head, sourceTip, counters)
      if (pair) {
        unlandedCommitCount = pair.ahead
        safeToDiscard = !isDirty && pair.ahead === 0
        needsSync = pair.behind > 0 && pair.treesDiffer
      }
      // pair === null: appraisal failed → every value stays at its fail-closed
      // default (`safeToDiscard: false`), matching appraiseWorktree's contract.
    }

    // Provisioning state is per-run and lives in memory, so a worktree with no
    // record (created before provisioning existed, or before a restart) simply
    // omits the field rather than claiming a state it cannot know.
    const provision = getProvisionState(wt.path)

    entries.push({
      worktreePath: wt.path,
      branchName,
      label: wt.path.split('/').filter(Boolean).pop() || branchName,
      title: title ?? undefined,
      sourceBranch,
      head: wt.head.slice(0, 7),
      lastCommitSubject,
      isDirty,
      unlandedCommitCount,
      needsSync,
      safeToDiscard,
      landedAt: landedAt ?? undefined,
      operationState: operation.state,
      conflictedPaths: operation.conflictedPaths.length > 0 ? operation.conflictedPaths : undefined,
      provisionState: provision?.state,
      provisionError: provision?.error,
    })
  }

  // Retired paths must not pin cached appraisals.
  pruneAppraisalCache(new Set(listed.map((w) => w.path)))

  const durationMs = Date.now() - startedAt
  log('inventoried worktrees', {
    repo_path: repoPath,
    count: entries.length,
    duration_ms: durationMs,
    appraisal_cache_hits: counters.hits,
    appraisal_cache_misses: counters.misses,
  })
  if (durationMs > 2000) {
    warn('inventory crawl slow', { repo_path: repoPath, duration_ms: durationMs, count: entries.length })
  }

  return {
    canonicalRepoPath: listed[0]?.path ?? null,
    aliasPaths: listed.map((w) => w.path),
    entries,
  }
}
